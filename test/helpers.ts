import { env } from 'cloudflare:test';
import { vi } from 'vitest';
import schema from '../schema.sql?raw';
import { issueToken } from '../src/auth';
import { newId } from '../src/db';

/** Fresh, empty tables for each test file. */
export async function resetDatabase(): Promise<void> {
  const tables = ['workouts', 'tokens', 'sessions', 'login_codes', 'users'];
  for (const table of tables) await env.DB.exec(`DROP TABLE IF EXISTS ${table}`);
  // Strip `--` comments first: a chunk of pure comment is not a statement.
  const statements = schema
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await env.DB.prepare(statement).run();
}

/** A user with an API token, skipping the login flow. */
export async function seedUser(email = 'test@example.com'): Promise<{ id: string; email: string; token: string }> {
  const id = newId(12);
  await env.DB.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
    .bind(id, email, new Date().toISOString())
    .run();
  const { token } = await issueToken(env, id, 'test');
  return { id, email, token };
}

/**
 * Run something that triggers a login email and return the code.
 *
 * With no email provider configured the Worker logs the code instead of
 * sending it, which is the same path `wrangler dev` takes.
 */
export async function captureLoginCode(run: () => Promise<unknown>): Promise<string> {
  const logged: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => void logged.push(args.join(' ')));
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  const match = logged.join('\n').match(/\[login\] code for \S+: (\d{6})/);
  if (!match) throw new Error(`no login code was logged; saw: ${logged.join(' | ')}`);
  return match[1];
}
