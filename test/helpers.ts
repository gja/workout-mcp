import { env } from 'cloudflare:test';
import schema from '../schema.sql?raw';
import { createUser } from '../src/db';

/** Fresh, empty tables for each test file. */
export async function resetDatabase(): Promise<void> {
  await env.DB.exec('DROP TABLE IF EXISTS workouts');
  await env.DB.exec('DROP TABLE IF EXISTS users');
  for (const statement of schema.split(';').map((s) => s.trim()).filter(Boolean)) {
    await env.DB.prepare(statement).run();
  }
}

export async function seedUser(name = 'test'): Promise<{ id: string; token: string }> {
  const { user, token } = await createUser(env, name);
  return { id: user.id, token };
}
