// The workout library: reference prose an assistant reads before writing a session.
// Read-only over MCP, editable from the dashboard or the API. See docs/library.md.

import DEFAULT_MARKDOWN from './library.md?raw';
import type { Env } from './db';
import { fail } from './units';

/** What ships in the box, used by every athlete who has not written their own. */
export const DEFAULT_LIBRARY = DEFAULT_MARKDOWN;

/** Generous for prose, small enough that one read stays one cheap D1 row. */
export const MAX_LIBRARY_CHARS = 100_000;

export type Library = {
  markdown: string;
  /** False while the athlete is still on the built-in library. */
  custom: boolean;
  /** When they last saved their own, or null while it is the default. */
  updated_at: string | null;
};

const asDefault = (): Library => ({ markdown: DEFAULT_LIBRARY, custom: false, updated_at: null });

export async function readLibrary(env: Env, userId: string): Promise<Library> {
  const row = await env.DB.prepare('SELECT markdown, updated_at FROM workout_libraries WHERE user_id = ?')
    .bind(userId)
    .first<{ markdown: string; updated_at: string }>();
  return row ? { markdown: row.markdown, custom: true, updated_at: row.updated_at } : asDefault();
}

/** Empty means "back to the default", so it deletes rather than storing nothing. */
export async function saveLibrary(env: Env, userId: string, markdown: unknown): Promise<Library> {
  if (typeof markdown !== 'string') fail('markdown', 'expected the library as a markdown string');
  if (markdown.length > MAX_LIBRARY_CHARS) {
    fail('markdown', `the library may be at most ${MAX_LIBRARY_CHARS} characters, and that one is ${markdown.length}`);
  }

  const text = markdown.trim();
  if (text === '') return await resetLibrary(env, userId);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO workout_libraries (user_id, markdown, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?3)
     ON CONFLICT (user_id) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
  )
    .bind(userId, text, now)
    .run();
  return { markdown: text, custom: true, updated_at: now };
}

/** Forget the athlete's own copy; the built-in library takes over again. */
export async function resetLibrary(env: Env, userId: string): Promise<Library> {
  await env.DB.prepare('DELETE FROM workout_libraries WHERE user_id = ?').bind(userId).run();
  return asDefault();
}
