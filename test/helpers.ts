import { env } from 'cloudflare:test';
import { issueToken } from '../src/auth';
import { newId } from '../src/db';

// The real migrations, in order, so a broken one fails the suite rather than
// the next deploy.
const MIGRATIONS = import.meta.glob('../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const statementsOf = (sql: string): string[] =>
  // Strip `--` comments first: a chunk of pure comment is not a statement.
  sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

/** Fresh tables for each test file, built by replaying every migration. */
export async function resetDatabase(): Promise<void> {
  const tables = ['workouts', 'workouts_rebuilt', 'tokens', 'sessions', 'login_states', 'users'];
  for (const table of tables) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);

  for (const path of Object.keys(MIGRATIONS).sort()) {
    for (const statement of statementsOf(MIGRATIONS[path])) {
      await env.DB.prepare(statement).run();
    }
  }
}

/** A user with an API token, skipping the sign-in flow. */
export async function seedUser(email = 'test@example.com'): Promise<{ id: string; email: string; token: string }> {
  const id = newId(12);
  await env.DB.prepare('INSERT INTO users (id, provider, subject, email, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, 'google', `subject-${id}`, email, new Date().toISOString())
    .run();
  const { token } = await issueToken(env, id, 'test');
  return { id, email, token };
}

const BASE = 'https://workouts.example';

/**
 * Drive a full sign-in and return the session cookie.
 *
 * The `code` handed to the callback picks what the stand-in provider returns,
 * so a test can ask for a bad issuer or an expired token by name.
 */
export async function signIn(provider: 'google' | 'apple' = 'google', code = 'ok'): Promise<Response> {
  const { SELF } = await import('cloudflare:test');

  const started = await SELF.fetch(`${BASE}/auth/${provider}/start`, { redirect: 'manual' });
  const state = new URL(started.headers.get('Location')!).searchParams.get('state')!;
  const params = new URLSearchParams({ code, state });

  // Google redirects back; Apple posts a form.
  return provider === 'google'
    ? SELF.fetch(`${BASE}/auth/google/callback?${params}`, { redirect: 'manual' })
    : SELF.fetch(`${BASE}/auth/apple/callback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        redirect: 'manual',
      });
}

/** Sign in and return just the cookie to send back. */
export async function sessionCookieFor(provider: 'google' | 'apple' = 'google'): Promise<string> {
  const response = await signIn(provider);
  const cookie = response.headers.get('Set-Cookie');
  if (!cookie) throw new Error(`sign-in did not set a session cookie (status ${response.status})`);
  return cookie.split(';')[0];
}
