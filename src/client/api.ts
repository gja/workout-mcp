// Talking to the Worker. Same-origin and cookie-authenticated, so no token handling here.

export type PlannedTotals = { seconds: number; meters: number; steps: number; open_steps: number };

export type Workout = {
  id: string;
  date: string;
  name: string;
  sport: string;
  sub_sport?: string;
  notes?: string;
  external_id?: string;
  /** An ISO instant, absent while the session is still only planned. */
  completed_at?: string;
  updated_at: string;
  /** Server-rendered prose. The first line is a header; the rest are the steps. */
  summary: string;
  planned?: PlannedTotals;
  fit_url: string;
  json_url: string;
};

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

/** The signed-in athlete, or null when nobody is. */
export const currentUser = (): Promise<Me | null> => getMe().then((me) => me, () => null);

export const listProviders = (): Promise<{ providers: string[] }> => request('/auth/providers');

export const listWorkouts = (): Promise<{ workouts: Workout[] }> => request('/api/workouts.json');
export const deleteWorkout = (workout: Workout): Promise<unknown> => request(workout.json_url, { method: 'DELETE' });

const completionUrl = (workout: Workout): string => `/api/workouts/${workout.date}/${workout.id}/complete`;

/** `completedAt` is an ISO instant; the server uses now without one. */
export const completeWorkout = (workout: Workout, completedAt?: string): Promise<Workout> =>
  request(completionUrl(workout), { method: 'POST', body: { completed_at: completedAt ?? null } });

/** Back to merely planned, leaving the plan itself alone. */
export const uncompleteWorkout = (workout: Workout): Promise<Workout> =>
  request(completionUrl(workout), { method: 'DELETE' });

/** A training platform, and where it stands for this athlete. */
export type Platform = {
  id: string;
  label: string;
  credential: { label: string; help: string; help_url: string };
  connected: boolean;
  account: string | null;
  last_error: string | null;
  /** How many workouts we have pushed and still track. */
  synced: number;
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
  error: string | null;
};

export const listPlatforms = (): Promise<{ configured: boolean; platforms: Platform[] }> =>
  request('/api/platforms');

export const connectPlatform = (id: string, key: string): Promise<{ account: string; sync: SyncReport }> =>
  request(`/api/platforms/${id}`, { method: 'PUT', body: { key } });

export const disconnectPlatform = (id: string): Promise<unknown> =>
  request(`/api/platforms/${id}`, { method: 'DELETE' });

export const syncPlatform = (id: string): Promise<SyncReport> =>
  request(`/api/platforms/${id}/sync`, { method: 'POST' });

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
export async function downloadFit(workout: Workout): Promise<void> {
  const response = await fetch(workout.fit_url);
  if (!response.ok) throw new Error(`could not export the FIT file (${response.status})`);

  const url = URL.createObjectURL(await response.blob());
  const link = Object.assign(document.createElement('a'), { href: url, download: `${workout.date}-${workout.id}.fit` });
  document.body.append(link);
  link.click();
  link.remove();
  // A later tick: revoking synchronously races the start of the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
