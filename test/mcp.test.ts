import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

let token: string;

beforeEach(async () => {
  await resetDatabase();
  ({ token } = await seedUser());
});

type RpcResult = {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

async function rpc(method: string, params?: unknown, id: number | null = 1): Promise<RpcResult> {
  const response = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return (await response.json()) as RpcResult;
}

/** Call a tool and return its structured result, asserting it did not error. */
async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const response = await rpc('tools/call', { name, arguments: args });
  expect(response.result?.isError, JSON.stringify(response.result)).toBeFalsy();
  return response.result?.structuredContent as Record<string, unknown>;
}

describe('protocol', () => {
  it('initializes', async () => {
    const response = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    expect(response.result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'workout-mcp' },
    });
  });

  it('lists every tool with an input schema', async () => {
    const { tools } = (await rpc('tools/list')).result as { tools: { name: string; inputSchema: unknown }[] };
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: 'object' });
  });

  it('answers a ping and rejects an unknown method', async () => {
    expect((await rpc('ping')).result).toEqual({});
    expect((await rpc('what/ever')).error).toMatchObject({ code: -32601 });
  });

  it('returns nothing for a notification', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    expect(response.status).toBe(202);
  });

  it('needs a token', async () => {
    const response = await SELF.fetch(`${BASE}/mcp`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer');
  });
});

describe('tools', () => {
  const intervals = {
    date: '2026-09-12',
    name: '8x400m',
    steps: [
      { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
      { repeat: 8, steps: [{ name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'] }] },
    ],
  };

  it('creates, reads, lists, updates and deletes a workout', async () => {
    const created = await callTool('create_workout', intervals);
    expect(created).toMatchObject({ date: '2026-09-12', name: '8x400m' });
    const id = created.id as string;

    expect(await callTool('get_workout', { date: '2026-09-12' })).toMatchObject({ id });

    const listed = (await callTool('list_workouts', {})) as { workouts: { id: string }[] };
    expect(listed.workouts.map((w) => w.id)).toEqual([id]);

    const updated = await callTool('update_workout', {
      id,
      current_date: '2026-09-12',
      date: '2026-09-13',
      name: 'Moved',
      steps: [{ goal_s: 1800 }],
    });
    expect(updated).toMatchObject({ id, date: '2026-09-13', name: 'Moved' });

    expect(await callTool('delete_workout', { date: '2026-09-13', id })).toMatchObject({ deleted: true });
  });

  it('asks which one when a date holds several workouts', async () => {
    await callTool('create_workout', intervals);
    await callTool('create_workout', { ...intervals, name: 'Second' });

    const result = (await callTool('get_workout', { date: '2026-09-12' })) as { message: string };
    expect(result.message).toContain('pass an id');
  });

  it('exports FIT bytes inline as well as by URL', async () => {
    const created = await callTool('create_workout', intervals);
    const exported = (await callTool('export_workout_fit', { date: created.date, id: created.id })) as {
      filename: string;
      base64: string;
      bytes: number;
    };

    expect(exported.filename).toBe(`2026-09-12-${created.id}.fit`);
    expect(exported.bytes).toBeGreaterThan(0);
    // ".FIT" is the type signature at bytes 8-11 of every FIT file header.
    expect(atob(exported.base64).slice(8, 12)).toBe('.FIT');
  });

  it('reports a bad workout as a tool error the model can act on', async () => {
    const response = await rpc('tools/call', {
      name: 'create_workout',
      arguments: { date: '2026-09-12', steps: [{ goal_s: 60, target_pace_km: ['nope', '-'] }] },
    });
    expect(response.result?.isError).toBe(true);
    expect(JSON.stringify(response.result?.content)).toContain('not a valid duration');
  });

  it('reports an unknown tool', async () => {
    const response = await rpc('tools/call', { name: 'make_coffee', arguments: {} });
    expect(response.result?.isError).toBe(true);
  });
});
