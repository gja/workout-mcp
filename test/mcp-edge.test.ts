// SPIKE DIAGNOSTIC — NOT A REGRESSION TEST.
// This file asks both handlers the same questions and reports the answers by
// THROWING the report, because workerd's console output is not forwarded by the
// vitest pool. It therefore FAILS BY DESIGN on every run. Delete it (and the
// other two spike diagnostics) before any of this is considered for merging.

import { SELF } from 'cloudflare:test';
import { beforeEach, it } from 'vitest';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';
const V = '2026-07-28';
let token: string;
beforeEach(async () => { await resetDatabase(); ({ token } = await seedUser()); });

const ENVELOPE = {
  'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientInfo': { name: 'spike', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

async function raw(path: string, headers: Record<string, string>, body: unknown) {
  const r = await SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  return `${r.status} ${t.replace(/\s+/g, ' ').slice(0, 150)}`;
}

it('edge cases', async () => {
  const out: string[] = [];
  const both = async (label: string, headers: Record<string, string>, body: unknown) => {
    out.push(`${label}\n  hand: ${await raw('/mcp', headers, body)}\n  sdk : ${await raw('/sdkmcp', headers, body)}`);
  };

  // RFC 2047-ish base64 Mcp-Name, as docs/mcp.md describes.
  const encoded = `=?base64?${btoa('list_workouts')}?=`;
  await both('Mcp-Name base64-encoded',
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call', 'Mcp-Name': encoded },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workouts', arguments: {}, _meta: ENVELOPE } });

  await both('Mcp-Name missing on tools/call',
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workouts', arguments: {}, _meta: ENVELOPE } });

  await both('modern body is an array',
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' },
    [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: ENVELOPE } }]);

  await both('malformed JSON body is handled', { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' }, '{{{' as never);

  await both('modern tools/call with a missing required argument',
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_workout' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_workout', arguments: {}, _meta: ENVELOPE } });

  await both('modern tools/call with an argument of the wrong type',
    { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'list_workouts' },
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_workouts', arguments: { limit: 'lots' }, _meta: ENVELOPE } });

  throw new Error('\n' + out.join('\n') + '\n');
}, 120_000);
