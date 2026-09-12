import { SELF, createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import * as drive from '../src/drive';
import { COPY_LIMIT, LOOKBACK_DAYS } from '../src/drive';
import { shiftDate, today } from '../src/units';
import { connectIntervals, resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

/** The shared drive the stand-in says the service account is a member of. */
const DRIVE = 'shared-drive-1';

let token: string;
let user: { id: string; email: string | null };

/** Arrange or read the stand-in upstream, through its service binding. */
const control = async <T>(path: string, body?: unknown): Promise<T> => {
  const response = await env.INTERVALS.fetch(`https://intervals.icu/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as T;
};

type DriveState = {
  files: Array<{ id: string; path: string; content: string }>;
  requests: Array<{ method: string; path: string; search: string }>;
};

const driveState = (): Promise<DriveState> => control<DriveState>('drive');

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

const connectPlatform = () => connectIntervals({ Authorization: `Bearer ${token}` });

type Report = { copied: number; remaining: number; paths: string[]; error: string | null };

/**
 * The drive has no HTTP surface any more — see "Retired" in docs/drive.md — so
 * these drive the module the routes used to call. `configure` throws where the
 * route answered 400, which is the only shape difference worth carrying here.
 */
const connectDrive = async (
  pasted = `https://drive.google.com/drive/folders/${DRIVE}`,
): Promise<{ ok: boolean; error: string | null; drive_name: string | null; sync: Report | null }> => {
  try {
    const found = await drive.configure(env, user, pasted);
    // The route ran the first copy straight away, and what it reported is asserted on.
    return { ok: true, error: null, drive_name: found.name, sync: await drive.copyNow(env, user) };
  } catch (err) {
    if (err instanceof drive.DriveError || err instanceof drive.DriveUnavailable) {
      return { ok: false, error: err.message, drive_name: null, sync: null };
    }
    throw err;
  }
};

const copyNow = (): Promise<Report> => drive.copyNow(env, user);

const driveStatus = () => drive.status(env, user);

const SESSION_DAY = shiftDate(today(), -2);
const MONTH = SESSION_DAY.slice(0, 7);

/** A recorded session, as intervals.icu reports one. */
const recorded = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'City Marathon',
  start_date_local: `${SESSION_DAY}T08:00:00`,
  file_type: 'fit',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  await control('reset');
  const seeded = await seedUser();
  token = seeded.token;
  user = { id: seeded.id, email: seeded.email };
});

describe('configuring a drive', () => {
  it('names the drive, and says which address to share it with', async () => {
    const connected = await connectDrive();
    expect(connected.ok).toBe(true);
    expect(connected.drive_name).toBe('Race Files');

    const status = await driveStatus();
    expect(status).toMatchObject({ configured: true, connected: true, drive_name: 'Race Files', copied: 0 });
    expect(status.service_account).toBe('workouts@test-project.iam.gserviceaccount.com');
  });

  it('accepts a bare drive id as well as a link', async () => {
    expect((await connectDrive(DRIVE)).ok).toBe(true);
  });

  it('refuses a drive the service account cannot see, and stores nothing', async () => {
    const refused = await connectDrive('https://drive.google.com/drive/folders/somebody-elses-drive');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('does not recognise');
    expect((await driveStatus()).connected).toBe(false);
  });

  it('refuses a folder, even one it can see, because a service account has no quota there', async () => {
    const refused = await connectDrive('https://drive.google.com/drive/u/2/folders/personal-folder-1');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('not a shared drive');
    expect((await driveStatus()).connected).toBe(false);
  });

  it('refuses a drive it can read but not write to, so a Viewer fails at the form', async () => {
    await control('setup', { driveFailing: { '/drive/v3/files': 403 } });

    expect((await connectDrive()).ok).toBe(false);
    expect((await driveStatus()).connected).toBe(false);
  });

  it('refuses something that is not a drive link at all', async () => {
    const refused = await connectDrive('not a drive');
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('Google Drive link');
  });

  it('forgets the drive, leaving what was copied where it is', async () => {
    await connectDrive();
    expect(await drive.forget(env, user)).toBe(true);
    expect((await driveStatus()).connected).toBe(false);
  });

  it('reports that no drive is configured rather than pretending to sync', async () => {
    const report = await copyNow();
    expect(report).toMatchObject({ copied: 0, error: 'no Google Drive is configured for this account' });
  });

  it('needs a session: the config is not readable without one', async () => {
    expect((await SELF.fetch(`${BASE}/api/config`)).status).toBe(401);
  });
});

describe('copying a recorded session', () => {
  beforeEach(async () => {
    await connectPlatform();
  });

  it('puts the recording at workouts-mcp/<platform>/yyyy-mm/yyyy-mm-dd-<id>-<name>.fit', async () => {
    await control('setup', { activities: [recorded('i555')] });

    const connected = await connectDrive();
    expect(connected.sync).toMatchObject({ copied: 1, remaining: 0, error: null });

    const { files } = await driveState();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(`workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i555-City-Marathon.fit`);
    // The athlete's own upload, not the one intervals.icu builds from the streams.
    expect(files[0].content).toBe('file:i555');
  });

  // The race flag used to decide this, and no longer does: an athlete who wants
  // their executed files wants all of them, and the flag is usually ticked later.
  it('copies an ordinary session too, not only the ones marked as a race', async () => {
    await control('setup', {
      activities: [
        recorded('i555'),
        { id: 'i556', name: 'Easy Ride', start_date_local: `${SESSION_DAY}T08:00:00`, file_type: 'fit' },
      ],
    });

    const connected = await connectDrive();
    expect(connected.sync).toMatchObject({ copied: 2 });
    expect((await driveState()).files.map((file) => file.path).sort()).toEqual([
      `workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i555-City-Marathon.fit`,
      `workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i556-Easy-Ride.fit`,
    ]);
  });

  /** A GPX upload, or a Strava-sourced activity, has no FIT of the athlete's own. */
  it('falls back to the FIT intervals.icu builds when the upload was not one', async () => {
    await control('setup', { activities: [recorded('i558', { file_type: 'gpx' })] });
    await connectDrive();

    const { files } = await driveState();
    expect(files[0].content).toBe('fit-file:i558');
    expect(files[0].path).toBe(`workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i558-City-Marathon.fit`);
  });

  it('copies each session once, however often it is asked', async () => {
    await control('setup', { activities: [recorded('i555')] });
    await connectDrive();

    expect(await copyNow()).toMatchObject({ copied: 0, remaining: 0, error: null });
    expect((await driveState()).files).toHaveLength(1);
  });

  /** Stands in for the hourly pass having claimed the session while "Copy now" was queueing it. */
  it('leaves a session another run has already claimed, rather than uploading it twice', async () => {
    await control('setup', { activities: [recorded('i560')] });
    await connectDrive();

    const { id: userId } = await seedUser('other@example.com');
    await env.DB.prepare(
      `INSERT INTO drive_copies (user_id, platform, remote_id, path, file_id, copied_at)
       VALUES (?, 'intervals', 'i560', 'claimed', NULL, ?)`,
    )
      .bind(userId, new Date().toISOString())
      .run();

    // Someone else's claim is not ours, so ours still goes.
    expect((await driveState()).files).toHaveLength(1);

    // Our own in-flight claim is: the session is skipped and nothing is uploaded again.
    await env.DB.prepare('UPDATE drive_copies SET file_id = NULL WHERE remote_id = ?').bind('i560').run();
    expect(await copyNow()).toMatchObject({ copied: 0, error: null });
    expect((await driveState()).files).toHaveLength(1);
  });

  it('reuses the month folder instead of making a second one', async () => {
    await control('setup', { activities: [recorded('i561'), recorded('i562', { name: 'Half' })] });
    await connectDrive();

    const { files, requests } = await driveState();
    expect(files).toHaveLength(2);
    // Three folders, made once between them: the root (at configure), the platform, the month.
    expect(requests.filter((seen) => seen.method === 'POST' && seen.path === '/drive/v3/files')).toHaveLength(3);
  });

  it('ignores a session older than the lookback', async () => {
    const old = shiftDate(today(), -(LOOKBACK_DAYS + 5));
    await control('setup', { activities: [recorded('i563', { start_date_local: `${old}T08:00:00` })] });

    expect((await connectDrive()).sync).toMatchObject({ copied: 0 });
    expect((await driveState()).files).toHaveLength(0);
  });

  it('caps a run and leaves the rest for the next one', async () => {
    const many = Array.from({ length: COPY_LIMIT + 2 }, (_, index) => recorded(`i6${index}`));
    await control('setup', { activities: many });

    expect((await connectDrive()).sync).toMatchObject({ copied: COPY_LIMIT, remaining: 2 });
    // A backlog clears itself next hour, so it is never reported as a failed copy.
    expect((await driveStatus()).last_error).toBeNull();

    expect(await copyNow()).toMatchObject({ copied: 2, remaining: 0, error: null });
    expect((await driveState()).files).toHaveLength(COPY_LIMIT + 2);
    expect((await driveStatus()).last_error).toBeNull();
  });

  // Every recorded session is queued now, and some have no file to fetch at all —
  // a manual entry, or one from Strava with no streams to build a FIT from.
  it('copies the rest of the batch when one session has no file to fetch', async () => {
    await control('setup', {
      activities: [recorded('i570'), recorded('i571', { name: 'Manual Entry' })],
      failing: { '/activity/i570/': 404 },
    });

    const connected = await connectDrive();
    expect(connected.sync).toMatchObject({ copied: 1 });
    // The failure is reported rather than swallowed, but it did not stop the run.
    expect(connected.sync!.error).toContain('404');
    expect((await driveState()).files.map((file) => file.path)).toEqual([
      `workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i571-Manual-Entry.fit`,
    ]);
  });

  it('names a file safely when the session name is full of path characters', async () => {
    await control('setup', { activities: [recorded('i564', { name: ' 10k / "PB" attempt ' })] });
    await connectDrive();

    const { files } = await driveState();
    expect(files[0].path).toBe(`workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i564-10k-PB-attempt.fit`);
  });

  it('records the failure against the drive rather than throwing', async () => {
    await control('setup', { activities: [recorded('i565')], failing: { '/activity/': 500 } });

    const connected = await connectDrive();
    expect(connected.sync?.error).toContain('500');
    expect((await driveStatus()).last_error).toContain('500');
    expect((await driveState()).files).toHaveLength(0);

    // The claim went back, so the session is still owed rather than silently dropped.
    await control('setup', { failing: {} });
    expect(await copyNow()).toMatchObject({ copied: 1, error: null });
    expect((await driveState()).files).toHaveLength(1);
  });

  it('stores nothing about the session itself beyond where it went', async () => {
    await control('setup', { activities: [recorded('i566')] });
    await connectDrive();

    const row = await env.DB.prepare('SELECT path, file_id FROM drive_copies').first<{ path: string; file_id: string }>();
    expect(row?.path).toContain('intervals.icu');
    expect(row?.file_id).toBeTruthy();
    // The recording is relayed, so no column anywhere holds its bytes.
    const columns = await env.DB.prepare('SELECT * FROM drive_copies').first<Record<string, unknown>>();
    expect(Object.keys(columns ?? {}).sort()).toEqual([
      'copied_at',
      'file_id',
      'path',
      'platform',
      'remote_id',
      'user_id',
    ]);
  });

  /**
   * The hourly cron is the whole of the integration for anyone not sat at the
   * dashboard: a session recorded overnight has to arrive without being asked for.
   */
  it('copies on the hourly pass, with nobody watching', async () => {
    await connectDrive();
    await control('setup', { activities: [recorded('i567')] });

    await worker.scheduled!(createScheduledController({ cron: '40 * * * *' }), env);

    const { files } = await driveState();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(`workouts-mcp/intervals.icu/${MONTH}/${SESSION_DAY}-i567-City-Marathon.fit`);
  });

  it('reports the most recent copies, for anything that asks what has gone', async () => {
    await control('setup', { activities: [recorded('i568')] });
    await connectDrive();

    const status = await driveStatus();
    expect(status.copied).toBe(1);
    expect(status.recent[0].path).toContain(`${SESSION_DAY}-i568-City-Marathon.fit`);
  });
});

describe('without a training platform', () => {
  it('has nothing to copy, and does not call Google for a file', async () => {
    await control('setup', { activities: [recorded('i569')] });
    expect((await connectDrive()).sync).toMatchObject({ copied: 0, remaining: 0, error: null });
    expect((await driveState()).files).toHaveLength(0);
  });
});
