// Talking to the Worker. Same-origin and cookie-authenticated, so no token handling here.

export type PlannedTotals = { seconds: number; meters: number; steps: number; open_steps: number };

export type Workout = {
  id: string;
  date: string;
  name: string;
  sport: string;
  sub_sport?: string;
  notes?: string;
  /** Free-form labels; absent rather than empty when there are none. */
  tags?: string[];
  external_id?: string;
  /** An ISO instant, absent while the session is still only planned. */
  completed_at?: string;
  /** Read-only here, as the completion is: written by the assistant or on the platform. */
  comment?: string;
  updated_at: string;
  /** Server-rendered prose. The first line is a header; the rest are the steps. */
  summary: string;
  planned?: PlannedTotals;
  /** The session recorded against it, totals only, or absent until one comes back. */
  stats?: StatsSummary;
  fit_url: string;
  json_url: string;
};

/** What a metric is measured in. Pace is seconds per kilometre, so lower is faster. */
export type Metric = 'hr' | 'pace_s_km' | 'power_w' | 'cadence';

export type LapTarget = {
  metric: Metric;
  low: number;
  high: number;
  pct_time_in_band: number;
  pct_time_above: number;
  pct_time_below: number;
};

/** One segment of the recording. Anything the session did not record is null, never 0. */
export type Lap = {
  index: number;
  role: string;
  rep_number: number | null;
  planned_step_index: number | null;
  planned_step_name: string | null;
  match_confidence: 'high' | 'low' | 'unmatched';
  duration_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  min_hr: number | null;
  avg_pace_s_km: number | null;
  avg_cadence: number | null;
  avg_power_w: number | null;
  target: LapTarget | null;
  flags: string[];
};

export type RecordedSession = {
  sport: string | null;
  indoor: boolean;
  elapsed_s: number | null;
  moving_s: number | null;
  distance_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace_s_km: number | null;
  avg_power_w: number | null;
  avg_cadence: number | null;
};

export type StatsSummary = {
  platform: string;
  activity_id: string;
  computed_at: string;
  /** Null when the recording could not be read; `flags` then says `source_unreadable`. */
  session: RecordedSession | null;
  flags: string[];
  error?: string;
};

export type WorkoutStats = StatsSummary & { laps: Lap[] };

/** The server's own reckoning of it — it is computed in UTC. */
export type Window = { from: string; to: string };

export type Me = { id: string; email: string | null; window: Window };

export type ApiToken = { prefix: string; name: string | null; created_at: string; last_used_at: string | null };
export type IssuedToken = { token: string; prefix: string; note: string };
export type Connection = { id: string; client_name: string; scope: string[]; created_at: string };
export type OAuthClient = { client_id: string; client_name: string };

type RequestOptions = { method?: string; body?: unknown };

async function request<T>(path: string, { method = 'GET', body }: RequestOptions = {}): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `request failed (${response.status})`);
  return data;
}

export const getMe = (): Promise<Me> => request('/api/me');

export const currentUser = (): Promise<Me | null> => getMe().then((me) => me, () => null);

export const listProviders = (): Promise<{ providers: string[] }> => request('/auth/providers');

export const listWorkouts = (): Promise<{ workouts: Workout[] }> => request('/api/workouts.json');
export const deleteWorkout = (workout: Workout): Promise<unknown> => request(workout.json_url, { method: 'DELETE' });

export const getWorkoutStats = (workout: Workout): Promise<WorkoutStats> =>
  request(`/api/workouts/${workout.date}/${workout.id}/stats`);

export type Platform = {
  id: string;
  label: string;
  /** What connecting is for, shown before they do. */
  connect_help: string;
  /** What the platform still needs from the athlete, once it is connected. */
  connected_note: string | null;
  connected: boolean;
  account: string | null;
  /** False when this deployment was never given the platform's OAuth client. */
  oauth: boolean;
  /** Whether the platform can say what is planned on it, and so offer the switch. */
  imports: boolean;
  /** Whether the athlete asked for those to be copied in. Off unless they did. */
  import_plan: boolean;
  last_error: string | null;
  /** How many workouts we have pushed and still track. */
  synced: number;
  /** How many of those came from the platform rather than went to it. */
  imported: number;
  updated_at: string | null;
};

/** `remaining` is what the per-run cap left behind. */
export type SyncReport = {
  platform: string;
  pushed: number;
  /** Taken off the platform because a delete had not reached it. */
  removed: number;
  remaining: number;
  completed: number;
  /** Copied off the platform's own calendar, where that is turned on. */
  imported: number;
  error: string | null;
};

/** The answer to the switch: what it is now, and what turning it on found. */
export type ImportReport = { enabled: boolean; imported: number; skipped: number; error: string | null };

/** Every integration's state in one read: each Setup panel takes its own slice. */
export type Config = { credentials_configured: boolean; platforms: Platform[] };

export const getConfig = (): Promise<Config> => request('/api/config');

export const disconnectPlatform = (id: string): Promise<unknown> =>
  request(`/api/config/${id}`, { method: 'DELETE' });

export const syncPlatform = (id: string): Promise<SyncReport> =>
  request(`/api/sync/${id}`, { method: 'POST' });

/** Turning it on reads their calendar straight away, which is what comes back. */
export const setPlanImport = (id: string, enabled: boolean): Promise<ImportReport> =>
  request(`/api/config/${id}/import`, { method: 'PUT', body: { enabled } });

export type ContextDocument = {
  kind: string;
  label: string;
  purpose: string;
  /** Null when nothing is set and the kind has no built-in document. */
  markdown: string | null;
  custom: boolean;
  /** True when clearing theirs leaves a document behind rather than nothing. */
  has_built_in: boolean;
  writable_over_mcp: boolean;
  /** The MCP tool an assistant reads this one with. */
  read_tool: string;
  updated_at: string | null;
};

export const listContexts = (): Promise<{ contexts: ContextDocument[] }> => request('/api/context');

export const saveContext = (kind: string, markdown: string): Promise<ContextDocument> =>
  request(`/api/context/${kind}`, { method: 'PUT', body: { markdown } });

/** Back to the built-in document, or to nothing where there is no built-in one. */
export const clearContext = (kind: string): Promise<ContextDocument> =>
  request(`/api/context/${kind}`, { method: 'DELETE' });

export const listTokens = (): Promise<{ tokens: ApiToken[] }> => request('/api/tokens');
export const createToken = (name: string): Promise<IssuedToken> => request('/api/tokens', { method: 'POST', body: { name } });
export const revokeToken = (prefix: string): Promise<unknown> => request(`/api/tokens/${prefix}`, { method: 'DELETE' });

export const listConnections = (): Promise<{ connections: Connection[] }> => request('/api/connections');
export const revokeConnection = (id: string): Promise<unknown> => request(`/api/connections/${id}`, { method: 'DELETE' });

export const describeClient = (clientId: string): Promise<OAuthClient> =>
  request(`/oauth/client?client_id=${encodeURIComponent(clientId)}`);

export const approveAuthorization = (query: string): Promise<{ redirect: string }> =>
  request(`/oauth/authorize${query}`, { method: 'POST' });

export const signOut = (): Promise<unknown> => request('/api/auth/logout', { method: 'POST' });

// Fetched as a blob so the session credential never lands in a URL or a history entry.
async function download(path: string, filename: string, whatFailed: string): Promise<void> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`could not ${whatFailed} (${response.status})`);

  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  // A later tick: revoking synchronously races the start of the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const downloadFit = (workout: Workout): Promise<void> =>
  download(workout.fit_url, `${workout.date}-${workout.id}.fit`, 'export the FIT file');

export const downloadContextBackup = (): Promise<void> =>
  download('/api/context.zip', 'backup-context.zip', 'export your context');
