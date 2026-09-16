// SPIKE DIAGNOSTIC — NOT A REGRESSION TEST.
// This file asks both handlers the same questions and reports the answers by
// THROWING the report, because workerd's console output is not forwarded by the
// vitest pool. It therefore FAILS BY DESIGN on every run. Delete it (and the
// other two spike diagnostics) before any of this is considered for merging.

import { SELF } from 'cloudflare:test';
import { beforeEach, it } from 'vitest';
import { resetDatabase, seedUser } from './helpers';

const V = '2026-07-28';
let token: string;
beforeEach(async () => { await resetDatabase(); ({ token } = await seedUser()); });

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientInfo': { name: 'spike', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

const call = async (path: string, name: string, args: unknown) => {
  const r = await SELF.fetch(`https://workouts.example${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call', 'Mcp-Name': name,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: ENVELOPE } }),
  });
  const b: any = JSON.parse(await r.text());
  return b.result?.isError ? `isError: ${b.result.content[0].text.slice(0, 110)}` : b.error ? `error ${b.error.code}` : 'accepted';
};

it('strictness', async () => {
  const out: string[] = [];
  const both = async (label: string, name: string, args: unknown) => {
    out.push(`${label}\n  hand: ${await call('/mcp', name, args)}\n  sdk : ${await call('/sdkmcp', name, args)}`);
  };

  const ok = { date: '2026-09-20', name: 'Easy', sport: 'running', steps: [{ name: 'Run', goal_s: 1800 }] };

  await both('valid create_workout', 'create_workout', ok);
  await both('unknown step property (target_zone)', 'create_workout',
    { ...ok, steps: [{ name: 'Run', goal_s: 1800, target_zone: ['2', '3'] }] });
  await both('unknown top-level property', 'create_workout', { ...ok, colour: 'blue' });
  await both('sport outside the enum', 'create_workout', { ...ok, sport: 'quidditch' });
  await both('steps as a bare object, not an array', 'create_workout', { ...ok, steps: { name: 'Run', goal_s: 60 } });
  await both('empty steps array', 'create_workout', { ...ok, steps: [] });
  await both('arguments omitted entirely', 'list_workouts', undefined);
  await both('arguments as a string', 'list_workouts', 'nope');

  throw new Error('\n' + out.join('\n') + '\n');
}, 120_000);
