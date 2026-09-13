import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  LINK_TTL_SECONDS,
  MAX_RANGE_DAYS,
  MAX_RECORDINGS,
  RANGE_SLACK_DAYS,
  signLink,
} from '../src/recordings';
import { shiftDate, today } from '../src/units';
import { connectIntervals, resetDatabase, seedUser } from './helpers';
import { readZip, type Extracted } from './zip-reader';

const BASE = 'https://workouts.example';

let token: string;
let userId: string;

const control = async (path: string, body?: unknown): Promise<void> => {
  const response = await env.INTERVALS.fetch(`https://intervals.icu/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(200);
};

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });

// --- Arranging ---------------------------------------------------------------

const DAY = shiftDate(today(), -3);

/** A recorded session, as intervals.icu reports one. */
const recorded = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'Morning Run',
  type: 'Run',
  start_date_local: `${DAY}T08:00:00`,
  file_type: 'fit',
  distance: 12000,
  moving_time: 3600,
  ...over,
});

type Listing = {
  count: number;
  omitted: number;
  sessions: Array<{ id: string; date: string; sport: string | null; file: string; distance_m: number | null }>;
  download_url: string | null;
  expires_at: string | null;
  note: string;
};

const listing = async (query: string): Promise<{ status: number; body: Listing & { error?: string } }> => {
  const response = await call(`/api/recordings?${query}`);
  return { status: response.status, body: (await response.json()) as Listing & { error?: string } };
};

const RANGE = `platform=intervals&from=${shiftDate(DAY, -1)}&to=${shiftDate(DAY, 1)}`;

/** Follow a signed link the way anything else would: no credential at all. */
const download = (url: string) => SELF.fetch(url);

const archiveFrom = async (url: string): Promise<Extracted[]> => {
  const response = await download(url);
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('application/zip');
  return readZip(new Uint8Array(await response.arrayBuffer()));
};

beforeEach(async () => {
  await resetDatabase();
  await control('reset');
  ({ id: userId, token } = await seedUser());
  await connectIntervals({ Authorization: `Bearer ${token}` });
});

// --- Listing -----------------------------------------------------------------

describe('listing recorded sessions', () => {
  it('reports what was recorded, and hands back a link to the files', async () => {
    await control('setup', { activities: [recorded('i1'), recorded('i2', { name: 'Evening Ride', type: 'Ride' })] });

    const { status, body } = await listing(RANGE);
    expect(status).toBe(200);
    expect(body.count).toBe(2);
    expect(body.sessions.map((session) => session.id)).toEqual(['i1', 'i2']);
    expect(body.sessions[0]).toMatchObject({
      date: DAY,
      sport: 'running',
      activity_type: 'Run',
      distance_m: 12000,
      moving_time_s: 3600,
      file: `${DAY}-i1-Morning-Run.fit`,
    });
    expect(body.sessions[1]).toMatchObject({ sport: 'cycling', activity_type: 'Ride' });

    expect(body.download_url).toContain('/downloads/completed-workouts.zip?claims=');
    const ttl = Date.parse(body.expires_at!) - Date.now();
    expect(ttl).toBeGreaterThan((LINK_TTL_SECONDS - 60) * 1000);
    expect(ttl).toBeLessThanOrEqual(LINK_TTL_SECONDS * 1000);
  });

  it('keeps only the sports asked for, and leaves out what it cannot place', async () => {
    await control('setup', {
      activities: [
        recorded('run', { type: 'TrailRun' }),
        recorded('ride', { type: 'VirtualRide' }),
        recorded('mystery', { type: 'Kitesurf' }),
      ],
    });

    const only = await listing(`${RANGE}&sport=running`);
    expect(only.body.sessions.map((session) => session.id)).toEqual(['run']);

    const both = await listing(`${RANGE}&sport=running&sport=cycling`);
    expect(both.body.sessions.map((session) => session.id)).toEqual(['ride', 'run']);

    // Unfiltered it is still listed — we just have no sport to call it.
    const all = await listing(RANGE);
    expect(all.body.sessions.find((session) => session.id === 'mystery')?.sport).toBeNull();
  });

  it('signs no link when the range holds nothing', async () => {
    const { body } = await listing(RANGE);
    expect(body).toMatchObject({ count: 0, download_url: null, expires_at: null });
    expect(body.note).toMatch(/No recorded sessions/);
  });

  it('takes the oldest of an over-full range, and says how many it left', async () => {
    const activities = Array.from({ length: MAX_RECORDINGS + 3 }, (_, at) =>
      recorded(`i${String(at).padStart(3, '0')}`),
    );
    await control('setup', { activities });

    const { body } = await listing(RANGE);
    expect(body.count).toBe(MAX_RECORDINGS);
    expect(body.omitted).toBe(3);
    expect(body.sessions[0].id).toBe('i000');
    expect(body.note).toMatch(/narrower range/);
  });

  it('refuses a range wider than one archive may cover', async () => {
    const to = shiftDate(DAY, MAX_RANGE_DAYS + RANGE_SLACK_DAYS);
    const { status, body } = await listing(`platform=intervals&from=${DAY}&to=${to}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(new RegExp(`at most ${MAX_RANGE_DAYS}`));
  });

  it('allows a fortnight named by its own edges, which is a day more than fourteen', async () => {
    // `from` a fortnight back and `to` today is 15 days once both ends count.
    const from = shiftDate(today(), -MAX_RANGE_DAYS);
    const { status } = await listing(`platform=intervals&from=${from}&to=${today()}`);
    expect(status).toBe(200);
  });

  it('insists on being told which platform, even though there is only one', async () => {
    const missing = await listing(`from=${DAY}&to=${DAY}`);
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/platform: is required/);

    const unknown = await listing(`platform=strava&from=${DAY}&to=${DAY}`);
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/not a platform/);
  });

  it('says so when the platform is not connected', async () => {
    await call('/api/config/intervals', { method: 'DELETE' });
    const { status, body } = await listing(RANGE);
    expect(status).toBe(400);
    expect(body.error).toMatch(/not connected/);
  });

  it('refuses a backwards range', async () => {
    const { status, body } = await listing(`platform=intervals&from=${DAY}&to=${shiftDate(DAY, -2)}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/is before from/);
  });
});

// --- Downloading -------------------------------------------------------------

describe('the archive', () => {
  it('streams every recorded file, with no credential on the request', async () => {
    await control('setup', {
      activities: [
        recorded('i1'),
        // No FIT of their own, so it is the one intervals.icu builds from the streams.
        recorded('i2', { name: 'Strava Ride', type: 'Ride', file_type: null }),
      ],
    });

    const { body } = await listing(RANGE);
    const files = await archiveFrom(body.download_url!);

    expect(files.map((file) => file.name).sort()).toEqual([
      `${DAY}-i1-Morning-Run.fit`,
      `${DAY}-i2-Strava-Ride.fit`,
      'manifest.json',
    ]);
    expect(files.every((file) => file.crcMatches)).toBe(true);

    // The stand-in answers with the endpoint that served it, so this asserts the
    // athlete's own upload and the generated file are each taken from the right place.
    expect(files.find((file) => file.name.includes('i1'))?.content).toBe('file:i1');
    expect(files.find((file) => file.name.includes('i2'))?.content).toBe('fit-file:i2');
  });

  it('describes itself in a manifest', async () => {
    await control('setup', { activities: [recorded('i1')] });
    const { body } = await listing(`${RANGE}&sport=running`);

    const files = await archiveFrom(body.download_url!);
    const manifest = JSON.parse(files.find((file) => file.name === 'manifest.json')!.content) as {
      platform: string;
      sport: string[];
      files: Array<{ id: string; file: string }>;
      failed: unknown[];
      omitted: number;
    };

    expect(manifest).toMatchObject({ platform: 'intervals', sport: ['running'], failed: [], omitted: 0 });
    expect(manifest.files).toEqual([expect.objectContaining({ id: 'i1', file: `${DAY}-i1-Morning-Run.fit` })]);
  });

  it('steps over a session with no file to fetch, and records why', async () => {
    await control('setup', { activities: [recorded('i1'), recorded('i2', { name: 'Manual' })] });
    const { body } = await listing(RANGE);

    // Only the generated-FIT endpoint fails, which is the shape a manual entry has.
    await control('setup', { failing: { 'i2/file': 404 } });

    const files = await archiveFrom(body.download_url!);
    expect(files.map((file) => file.name)).toContain(`${DAY}-i1-Morning-Run.fit`);
    expect(files.map((file) => file.name)).not.toContain(`${DAY}-i2-Manual.fit`);

    const manifest = JSON.parse(files.find((file) => file.name === 'manifest.json')!.content) as {
      failed: Array<{ id: string; error: string }>;
    };
    expect(manifest.failed).toEqual([expect.objectContaining({ id: 'i2' })]);
  });

  it('is not indexed, and not cached', async () => {
    await control('setup', { activities: [recorded('i1')] });
    const { body } = await listing(RANGE);

    const response = await download(body.download_url!);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Robots-Tag')).toMatch(/noindex/);
    expect(response.headers.get('Content-Disposition')).toContain('.zip');
    await response.arrayBuffer();
  });
});

// --- The signature -----------------------------------------------------------

describe('the signed link', () => {
  it('refuses one whose claims have been edited', async () => {
    await control('setup', { activities: [recorded('i1')] });
    const { body } = await listing(RANGE);

    // Widen the range by a year, leaving the signature over what was asked for.
    const url = new URL(body.download_url!);
    const claims = JSON.parse(atob(url.searchParams.get('claims')!)) as { f: string; t: string };
    expect(claims.t).toBe(shiftDate(DAY, 1));
    claims.t = shiftDate(DAY, 300);
    url.searchParams.set('claims', btoa(JSON.stringify(claims)).replace(/=+$/, ''));

    const response = await download(url.toString());
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/altered/);
  });

  it('refuses one with the signature taken off', async () => {
    await control('setup', { activities: [recorded('i1')] });
    const { body } = await listing(RANGE);

    const url = new URL(body.download_url!);
    url.searchParams.delete('signature');

    const response = await download(url.toString());
    expect(response.status).toBe(403);
  });

  it('refuses one that has expired', async () => {
    await control('setup', { activities: [recorded('i1')] });

    const stale = new Date(Date.now() - (LINK_TTL_SECONDS + 60) * 1000);
    const { url } = await signLink(
      env,
      userId,
      { platform: 'intervals', from: shiftDate(DAY, -1), to: shiftDate(DAY, 1), sports: null },
      BASE,
      stale,
    );

    const response = await download(url);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toMatch(/expired/);
  });

  it('refuses nonsense in place of a link', async () => {
    const bare = await download(`${BASE}/downloads/completed-workouts.zip`);
    expect(bare.status).toBe(403);

    const junk = await download(`${BASE}/downloads/completed-workouts.zip?claims=nope&signature=nope`);
    expect(junk.status).toBe(403);
  });

  it('names the athlete inside the signature, so it cannot be pointed at anyone else', async () => {
    await control('setup', { activities: [recorded('i1')] });
    const other = await seedUser('someone-else@example.com');

    // A link signed for an athlete with no platform connected fetches nothing of ours.
    const { url } = await signLink(
      env,
      other.id,
      { platform: 'intervals', from: shiftDate(DAY, -1), to: shiftDate(DAY, 1), sports: null },
      BASE,
    );

    const response = await download(url);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/not connected/);
  });
});

// --- Over MCP ----------------------------------------------------------------

describe('over the tool surface', () => {
  it('answers the same over REST as the tool does', async () => {
    await control('setup', { activities: [recorded('i1')] });

    const response = await call('/api/tools/list_recorded_workouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'intervals', from: shiftDate(DAY, -1), to: shiftDate(DAY, 1) }),
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as Listing;
    expect(body.count).toBe(1);
    expect(body.download_url).toContain(`${BASE}/downloads/completed-workouts.zip?`);

    const files = await archiveFrom(body.download_url!);
    expect(files.map((file) => file.name)).toContain(`${DAY}-i1-Morning-Run.fit`);
  });
});
