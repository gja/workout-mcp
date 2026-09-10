import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools';
import { shiftDate, today } from '../src/units';
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

  it('marks which tools only read, so a client can allow those without asking', async () => {
    const { tools } = (await rpc('tools/list')).result as {
      tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[];
    };
    const readOnly = tools.filter((tool) => tool.annotations?.readOnlyHint).map((tool) => tool.name);
    const destructive = tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name);

    expect(readOnly.sort()).toEqual(['export_workout_fit', 'get_workout', 'list_workouts']);
    expect(destructive.sort()).toEqual(['delete_workout', 'update_workout']);
    // Every tool says which it is, rather than leaving a client to guess.
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBeTypeOf('boolean');
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
    // RFC 9728: the challenge tells the client where the OAuth flow starts.
    expect(response.headers.get('WWW-Authenticate')).toContain(
      `resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`,
    );
  });
});

describe('tools', () => {
  // Relative to today: a workout only exists inside the retention window, so a
  // literal date would fall out of it as real time moved past.
  const DAY = shiftDate(today(), 2);
  const NEXT_DAY = shiftDate(today(), 3);

  const intervals = {
    date: DAY,
    name: '8x400m',
    steps: [
      { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
      { repeat: 8, steps: [{ name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'] }] },
    ],
  };

  it('creates, reads, lists, updates and deletes a workout', async () => {
    const created = await callTool('create_workout', intervals);
    expect(created).toMatchObject({ date: DAY, name: '8x400m' });
    const id = created.id as string;

    expect(await callTool('get_workout', { date: DAY })).toMatchObject({ id });

    const listed = (await callTool('list_workouts', {})) as { workouts: { id: string }[] };
    expect(listed.workouts.map((w) => w.id)).toEqual([id]);

    const updated = await callTool('update_workout', {
      id,
      current_date: DAY,
      date: NEXT_DAY,
      name: 'Moved',
      steps: [{ goal_s: 1800 }],
    });
    expect(updated).toMatchObject({ id, date: NEXT_DAY, name: 'Moved' });

    expect(await callTool('delete_workout', { date: NEXT_DAY, id })).toMatchObject({ deleted: true });
  });

  it('asks which one when a date holds several workouts', async () => {
    await callTool('create_workout', intervals);
    await callTool('create_workout', { ...intervals, name: 'Second' });

    const result = (await callTool('get_workout', { date: DAY })) as { message: string };
    expect(result.message).toContain('pass an id');
  });

  it('exports FIT bytes inline as well as by URL', async () => {
    const created = await callTool('create_workout', intervals);
    const exported = (await callTool('export_workout_fit', { date: created.date, id: created.id })) as {
      filename: string;
      base64: string;
      bytes: number;
    };

    expect(exported.filename).toBe(`${DAY}-${created.id}.fit`);
    expect(exported.bytes).toBeGreaterThan(0);
    // ".FIT" is the type signature at bytes 8-11 of every FIT file header.
    expect(atob(exported.base64).slice(8, 12)).toBe('.FIT');
  });

  it('reports a bad workout as a tool error the model can act on', async () => {
    const response = await rpc('tools/call', {
      name: 'create_workout',
      arguments: { date: DAY, steps: [{ goal_s: 60, target_pace_km: ['nope', '-'] }] },
    });
    expect(response.result?.isError).toBe(true);
    expect(JSON.stringify(response.result?.content)).toContain('not a valid duration');
  });

  it('reports an unknown tool', async () => {
    const response = await rpc('tools/call', { name: 'make_coffee', arguments: {} });
    expect(response.result?.isError).toBe(true);
  });
});
