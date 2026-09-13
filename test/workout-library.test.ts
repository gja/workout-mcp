import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIBRARY, MAX_LIBRARY_CHARS } from '../src/workout-library';
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

type WorkoutLibrary = { markdown: string; custom: boolean; updated_at: string | null };

const read = async (): Promise<WorkoutLibrary> => (await call('/api/workout-library')).json<WorkoutLibrary>();

const write = (markdown: string) =>
  call('/api/workout-library', { method: 'PUT', body: JSON.stringify({ markdown }) });

describe('the workout library over REST', () => {
  it('serves the built-in library to an athlete who has never written one', async () => {
    const library = await read();
    expect(library).toMatchObject({ custom: false, updated_at: null });
    expect(library.markdown).toBe(DEFAULT_LIBRARY);
  });

  it('saves the athlete\'s own, and reads it back', async () => {
    const response = await write('# Mine\n\nOnly threshold work.');
    expect(response.status).toBe(200);

    const library = await read();
    expect(library.markdown).toBe('# Mine\n\nOnly threshold work.');
    expect(library.custom).toBe(true);
    expect(library.updated_at).toBeTruthy();
  });

  it('goes back to the built-in library on delete', async () => {
    await write('# Mine');
    const response = await call('/api/workout-library', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await read()).toMatchObject({ custom: false, markdown: DEFAULT_LIBRARY });
  });

  it('reads an empty save as "use the built-in one" rather than storing nothing', async () => {
    await write('# Mine');
    await write('   \n  ');
    expect(await read()).toMatchObject({ custom: false, markdown: DEFAULT_LIBRARY });
  });

  it('refuses a library that is not a string, naming the field', async () => {
    const response = await call('/api/workout-library', { method: 'PUT', body: JSON.stringify({ markdown: 42 }) });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain('markdown');
  });

  it('refuses one past the size limit', async () => {
    const response = await write('x'.repeat(MAX_LIBRARY_CHARS + 1));
    expect(response.status).toBe(400);
  });

  it('is behind the door', async () => {
    expect((await SELF.fetch(`${BASE}/api/workout-library`)).status).toBe(401);
  });

  it('is one library per athlete', async () => {
    await write('# Mine');
    const other = await seedUser('other@example.com');
    const response = await SELF.fetch(`${BASE}/api/workout-library`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(await response.json<WorkoutLibrary>()).toMatchObject({ custom: false });
  });
});

describe('the workout library over MCP', () => {
  const callTool = async (): Promise<Record<string, unknown>> => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_workout_library', arguments: {} },
      }),
    });
    const body = (await response.json()) as { result?: { structuredContent?: Record<string, unknown> } };
    return body.result?.structuredContent ?? {};
  };

  it('reads the library, and says where it can be changed', async () => {
    const result = await callTool();
    expect(result.markdown).toBe(DEFAULT_LIBRARY);
    expect(result.custom).toBe(false);
    expect(result.note).toContain('PUT /api/workout-library');
  });

  it('reads the athlete\'s own once they have written one', async () => {
    await write('# Mine');
    const result = await callTool();
    expect(result).toMatchObject({ markdown: '# Mine', custom: true });
  });

  it('has no write tool for it', async () => {
    const { TOOLS } = await import('../src/tools');
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toContain('get_workout_library');
    expect(names.filter((name) => name.includes('library'))).toEqual(['get_workout_library']);
  });
});
