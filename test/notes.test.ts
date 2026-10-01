import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_NOTES_PER_USER, NOTE_DAYS_FUTURE } from '../src/db';
import { MAX_NOTE_DAYS } from '../src/note';
import { shiftDate, today } from '../src/units';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

let token: string;

beforeEach(async () => {
  await resetDatabase();
  ({ token } = await seedUser());
});

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

const tool = (name: string, args: unknown) => call(`/api/tools/${name}`, { method: 'POST', body: JSON.stringify(args) });

type Note = { id: string; date: string; end_date: string; text: string };

const day = (offset: number) => shiftDate(today(), offset);

async function addNote(body: unknown): Promise<Note> {
  const response = await call('/api/notes', { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(201);
  return (await response.json()) as Note;
}

async function listed(query = ''): Promise<Note[]> {
  const response = await call(`/api/workouts.json${query}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { notes: Note[] }).notes;
}

describe('notes over REST', () => {
  it('comes back beside the workouts, a single day ending where it starts', async () => {
    const note = await addNote({ date: day(2), text: '  Race day  ' });
    expect(note).toMatchObject({ date: day(2), end_date: day(2), text: 'Race day' });
    expect(await listed()).toMatchObject([{ id: note.id, text: 'Race day' }]);
  });

  it('is listed for any range it overlaps, and only those', async () => {
    const trip = await addNote({ date: day(3), end_date: day(8), text: 'Travelling: easy runs only' });

    for (const [from, to] of [[day(3), day(3)], [day(8), day(8)], [day(5), day(6)], [day(0), day(12)], [day(1), day(3)]]) {
      expect((await listed(`?from=${from}&to=${to}`)).map((n) => n.id)).toEqual([trip.id]);
    }
    expect(await listed(`?from=${day(0)}&to=${day(2)}`)).toEqual([]);
    expect(await listed(`?from=${day(9)}&to=${day(12)}`)).toEqual([]);
  });

  it('reaches further ahead than a workout may', async () => {
    const trip = await addNote({ date: day(NOTE_DAYS_FUTURE - 5), end_date: day(NOTE_DAYS_FUTURE + 5), text: 'Holiday' });
    expect((await listed()).map((n) => n.id)).toEqual([trip.id]);

    const replaced = await call(`/api/notes/${trip.id}`, {
      method: 'PUT',
      body: JSON.stringify({ date: day(NOTE_DAYS_FUTURE), text: 'Holiday, one day' }),
    });
    expect(replaced.status).toBe(200);
  });

  it('finds a note begun before the window that runs into it', async () => {
    const injury = await addNote({ date: day(-20), end_date: day(1), text: 'Calf: no speed work' });
    expect((await listed()).map((n) => n.id)).toEqual([injury.id]);
  });

  it('is replaced by id, and deleted', async () => {
    const note = await addNote({ date: day(1), text: 'Busy' });

    const replaced = await call(`/api/notes/${note.id}`, {
      method: 'PUT',
      body: JSON.stringify({ date: day(1), end_date: day(2), text: 'Busy both days' }),
    });
    expect(replaced.status).toBe(200);
    expect(await listed()).toMatchObject([{ id: note.id, end_date: day(2), text: 'Busy both days' }]);

    expect((await call(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(await listed()).toEqual([]);
    expect((await call(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('refuses what it could not hold, naming the field', async () => {
    const refused = async (body: unknown, message: string) => {
      const response = await call('/api/notes', { method: 'POST', body: JSON.stringify(body) });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain(message);
    };
    await refused({ date: day(2), end_date: day(1), text: 'x' }, 'end_date');
    await refused({ date: day(0), end_date: day(MAX_NOTE_DAYS), text: 'x' }, `at most ${MAX_NOTE_DAYS} days`);
    await refused({ date: day(2), text: '   ' }, 'text');
    await refused({ date: day(NOTE_DAYS_FUTURE + 1), text: 'x' }, 'date');
    await refused({ date: day(2), text: 'x', sport: 'running' }, 'unknown field sport');
  });

  it('keeps a bounded number at a time', async () => {
    for (let i = 0; i < MAX_NOTES_PER_USER; i++) await addNote({ date: day(1), text: `note ${i}` });
    const response = await call('/api/notes', { method: 'POST', body: JSON.stringify({ date: day(1), text: 'one more' }) });
    expect(response.status).toBe(400);
  });

  it('cannot pass the cap by reviving a note that has aged out', async () => {
    const aged = await addNote({ date: day(1), text: 'old' });
    await env.DB.prepare('UPDATE notes SET date = ?, end_date = ? WHERE id = ?').bind(day(-60), day(-60), aged.id).run();
    for (let i = 0; i < MAX_NOTES_PER_USER; i++) await addNote({ date: day(1), text: `note ${i}` });

    const revived = await call(`/api/notes/${aged.id}`, { method: 'PUT', body: JSON.stringify({ date: day(1), text: 'back' }) });
    expect(revived.status).toBe(400);
  });

  it('replaces a note at the cap, which adds nothing to it', async () => {
    const notes: Note[] = [];
    for (let i = 0; i < MAX_NOTES_PER_USER; i++) notes.push(await addNote({ date: day(1), text: `note ${i}` }));
    const replaced = await call(`/api/notes/${notes[0].id}`, { method: 'PUT', body: JSON.stringify({ date: day(2), text: 'moved' }) });
    expect(replaced.status).toBe(200);
  });

  it('is never another athlete\'s', async () => {
    const note = await addNote({ date: day(1), text: 'Mine' });
    ({ token } = await seedUser('other@example.com'));
    expect(await listed()).toEqual([]);
    expect((await call(`/api/notes/${note.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('save_note', () => {
  it('adds, replaces and deletes, and list_workouts carries the result', async () => {
    const added = (await (await tool('save_note', { date: day(1), end_date: day(4), text: 'Away' })).json()) as Note;
    expect(added.end_date).toBe(day(4));

    const replaced = await tool('save_note', { id: added.id, date: day(1), text: 'Away one day' });
    expect(replaced.status).toBe(200);

    const { notes } = (await (await tool('list_workouts', {})).json()) as { notes: Note[] };
    expect(notes).toMatchObject([{ id: added.id, end_date: day(1), text: 'Away one day' }]);

    expect(await (await tool('save_note', { id: added.id, text: '' })).json()).toEqual({ deleted: true, id: added.id });
    expect((await tool('save_note', { text: '' })).status).toBe(400);
  });
});

describe('the overlap read', () => {
  it('is a range scan answered from the index', async () => {
    const { results } = await env.DB.prepare(
      'EXPLAIN QUERY PLAN SELECT id, date, end_date FROM notes ' +
        'WHERE user_id = ? AND date >= ? AND date <= ? AND end_date >= ?',
    )
      .bind('u', day(-30), day(15), day(-1))
      .all<{ detail: string }>();
    const plan = results.map((row) => row.detail).join('\n');
    expect(plan).toContain('notes_by_date');
    expect(plan).toContain('date>? AND date<?');
  });
});
