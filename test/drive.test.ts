import { SELF, createScheduledController, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../src/index';
import { COPY_LIMIT, LOOKBACK_DAYS } from '../src/drive';
import { shiftDate, today } from '../src/units';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';
const KEY = 'an-intervals-api-key';

/** The shared drive the stand-in says the service account is a member of. */
const DRIVE = 'shared-drive-1';

let token: string;

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

const connectPlatform = () =>
  call('/api/platforms/intervals', { method: 'PUT', body: JSON.stringify({ key: KEY }) });

type Report = { copied: number; remaining: number; paths: string[]; error: string | null };

const connectDrive = async (drive = `https://drive.google.com/drive/folders/${DRIVE}`) => {
  const response = await call('/api/drive', { method: 'PUT', body: JSON.stringify({ drive }) });
  return { response, body: (await response.json()) as { drive_name?: string; sync?: Report; error?: string } };
};

const copyNow = async (): Promise<Report> =>
  (await (await call('/api/drive/sync', { method: 'POST' })).json()) as Report;

const driveStatus = async () =>
  (await (await call('/api/drive')).json()) as {
    configured: boolean;
    service_account: string | null;
    connected: boolean;
    drive_name: string | null;
    last_error: string | null;
    copied: number;
    recent: Array<{ path: string }>;
  };

const RACE_DAY = shiftDate(today(), -2);
const MONTH = RACE_DAY.slice(0, 7);

/** A recorded race, as intervals.icu reports one. */
const race = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: 'City Marathon',
  start_date_local: `${RACE_DAY}T08:00:00`,
  race: true,
  file_type: 'fit',
  ...over,
});

beforeEach(async () => {
  await resetDatabase();
  await control('reset');
  ({ token } = await seedUser());
});

describe('configuring a drive', () => {
  it('names the drive, and says which address to share it with', async () => {
    const { response, body } = await connectDrive();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ drive_name: 'Race Files' });

    const status = await driveStatus();
    expect(status).toMatchObject({ configured: true, connected: true, drive_name: 'Race Files', copied: 0 });
    expect(status.service_account).toBe('workouts@test-project.iam.gserviceaccount.com');
  });

  it('accepts a bare drive id as well as a link', async () => {
    expect((await connectDrive(DRIVE)).response.status).toBe(200);
  });

  it('refuses a drive the service account cannot see, and stores nothing', async () => {
    const { response } = await connectDrive('https://drive.google.com/drive/folders/somebody-elses-drive');
    expect(response.status).toBe(400);
    expect((await driveStatus()).connected).toBe(false);
  });

  it('refuses something that is not a drive link at all', async () => {
    const { response, body } = await connectDrive('not a drive');
    expect(response.status).toBe(400);
    expect(body.error).toContain('Google Drive link');
  });

  it('forgets the drive, leaving what was copied where it is', async () => {
    await connectDrive();
    expect((await call('/api/drive', { method: 'DELETE' })).status).toBe(200);
    expect((await driveStatus()).connected).toBe(false);
  });

  it('reports that no drive is configured rather than pretending to sync', async () => {
    const report = await copyNow();
    expect(report).toMatchObject({ copied: 0, error: 'no Google Drive is configured for this account' });
  });

  it('needs a session: the drive is not readable without one', async () => {
    expect((await SELF.fetch(`${BASE}/api/drive`)).status).toBe(401);
  });
});

describe('copying a race', () => {
  beforeEach(async () => {
    await connectPlatform();
  });

  it('puts the recording at workouts-mcp/yyyy-mm/<platform>/yyyy-mm-dd-<id>-name.fit', async () => {
    await control('setup', { activities: [race('i555')] });

    const { body } = await connectDrive();
    expect(body.sync).toMatchObject({ copied: 1, remaining: 0, error: null });

    const { files } = await driveState();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(`workouts-mcp/${MONTH}/intervals.icu/${RACE_DAY}-i555-City-Marathon.fit`);
    // The athlete's own upload, not the one intervals.icu builds from the streams.
    expect(files[0].content).toBe('file:i555');
  });

  it('leaves an ordinary session alone — only a race is copied', async () => {
    await control('setup', {
      activities: [
        race('i555'),
        { id: 'i556', name: 'Easy Ride', start_date_local: `${RACE_DAY}T08:00:00`, race: false, file_type: 'fit' },
      ],
    });

    const { body } = await connectDrive();
    expect(body.sync).toMatchObject({ copied: 1 });
    expect((await driveState()).files.map((file) => file.path)).toEqual([
      `workouts-mcp/${MONTH}/intervals.icu/${RACE_DAY}-i555-City-Marathon.fit`,
    ]);
  });

  it('takes a RACE sub-type as a race too', async () => {
    await control('setup', { activities: [race('i557', { race: undefined, sub_type: 'RACE' })] });
    expect((await connectDrive()).body.sync).toMatchObject({ copied: 1 });
  });

  /** A GPX upload, or a Strava-sourced activity, has no FIT of the athlete's own. */
  it('falls back to the FIT intervals.icu builds when the upload was not one', async () => {
    await control('setup', { activities: [race('i558', { file_type: 'gpx' })] });
    await connectDrive();

    const { files } = await driveState();
    expect(files[0].content).toBe('fit-file:i558');
    expect(files[0].path).toBe(`workouts-mcp/${MONTH}/intervals.icu/${RACE_DAY}-i558-City-Marathon.fit`);
  });

  it('copies each race once, however often it is asked', async () => {
    await control('setup', { activities: [race('i555')] });
    await connectDrive();

    expect(await copyNow()).toMatchObject({ copied: 0, remaining: 0, error: null });
    expect((await driveState()).files).toHaveLength(1);
  });

  it('reuses the month folder instead of making a second one', async () => {
    await control('setup', { activities: [race('i561'), race('i562', { name: 'Half' })] });
    await connectDrive();

    const { files, requests } = await driveState();
    expect(files).toHaveLength(2);
    // Three folders, made once between them: the root, the month, the platform.
    expect(requests.filter((seen) => seen.method === 'POST' && seen.path === '/drive/v3/files')).toHaveLength(3);
  });

  it('ignores a race older than the lookback', async () => {
    const old = shiftDate(today(), -(LOOKBACK_DAYS + 5));
    await control('setup', { activities: [race('i563', { start_date_local: `${old}T08:00:00` })] });

    expect((await connectDrive()).body.sync).toMatchObject({ copied: 0 });
    expect((await driveState()).files).toHaveLength(0);
  });

  it('caps a run and leaves the rest for the next one', async () => {
    const many = Array.from({ length: COPY_LIMIT + 2 }, (_, index) => race(`i6${index}`));
    await control('setup', { activities: many });

    expect((await connectDrive()).body.sync).toMatchObject({ copied: COPY_LIMIT, remaining: 2 });
    expect((await driveStatus()).last_error).toBe('2 left to copy');

    expect(await copyNow()).toMatchObject({ copied: 2, remaining: 0, error: null });
    expect((await driveState()).files).toHaveLength(COPY_LIMIT + 2);
    expect((await driveStatus()).last_error).toBeNull();
  });

  it('names a file safely when the race name is full of path characters', async () => {
    await control('setup', { activities: [race('i564', { name: ' 10k / "PB" attempt ' })] });
    await connectDrive();

    const { files } = await driveState();
    expect(files[0].path).toBe(`workouts-mcp/${MONTH}/intervals.icu/${RACE_DAY}-i564-10k-PB-attempt.fit`);
  });

  it('records the failure against the drive rather than throwing', async () => {
    await control('setup', { activities: [race('i565')], failing: { '/activity/': 500 } });

    const { body } = await connectDrive();
    expect(body.sync?.error).toContain('500');
    expect((await driveStatus()).last_error).toContain('500');
    expect((await driveState()).files).toHaveLength(0);
  });

  it('stores nothing about the race itself beyond where it went', async () => {
    await control('setup', { activities: [race('i566')] });
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
   * dashboard: a race recorded overnight has to arrive without being asked for.
   */
  it('copies on the hourly pass, with nobody watching', async () => {
    await connectDrive();
    await control('setup', { activities: [race('i567')] });

    await worker.scheduled!(createScheduledController({ cron: '20 * * * *' }), env);

    const { files } = await driveState();
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(`workouts-mcp/${MONTH}/intervals.icu/${RACE_DAY}-i567-City-Marathon.fit`);
  });

  it('lists the most recent copies on the dashboard', async () => {
    await control('setup', { activities: [race('i568')] });
    await connectDrive();

    const status = await driveStatus();
    expect(status.copied).toBe(1);
    expect(status.recent[0].path).toContain(`${RACE_DAY}-i568-City-Marathon.fit`);
  });
});

describe('without a training platform', () => {
  it('has nothing to copy, and does not call Google for a file', async () => {
    await control('setup', { activities: [race('i569')] });
    expect((await connectDrive()).body.sync).toMatchObject({ copied: 0, remaining: 0, error: null });
    expect((await driveState()).files).toHaveLength(0);
  });
});
