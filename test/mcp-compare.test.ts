// SPIKE DIAGNOSTIC — NOT A REGRESSION TEST.
// This file asks both handlers the same questions and reports the answers by
// THROWING the report, because workerd's console output is not forwarded by the
// vitest pool. It therefore FAILS BY DESIGN on every run. Delete it (and the
// other two spike diagnostics) before any of this is considered for merging.

// SPIKE: the hand-rolled /mcp and the library /sdkmcp, asked the same things,
// with the answers printed side by side. Reports drift; asserts almost nothing.

import { SELF } from 'cloudflare:test';
import { beforeEach, it } from 'vitest';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';
const MODERN = '2026-07-28';

let token: string;
beforeEach(async () => {
  await resetDatabase();
  ({ token } = await seedUser());
});

const NAMED_BY: Record<string, string> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

async function ask(
  path: string,
  method: string,
  params: Record<string, unknown> = {},
  opts: { version?: string | null; headers?: Record<string, string>; id?: number | null; meta?: boolean } = {},
) {
  const version = opts.version === undefined ? MODERN : opts.version;
  const named = NAMED_BY[method] === undefined ? null : String(params[NAMED_BY[method]] ?? '');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(version === null ? {} : { 'MCP-Protocol-Version': version, 'Mcp-Method': method }),
    ...(version === null || named === null ? {} : { 'Mcp-Name': named }),
    ...opts.headers,
  };
  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (opts.id !== null) body.id = opts.id ?? 1;
  body.params =
    version === null || opts.meta === false
      ? params
      : {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientInfo': { name: 'spike', version: '1' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        };

  const r = await SELF.fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text.includes('data: ')
      ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
      : text ? JSON.parse(text) : null;
  } catch { parsed = text.slice(0, 120); }
  return { status: r.status, parsed };
}

const digest = (r: { status: number; parsed: any }) => {
  const p = r.parsed;
  if (p === null) return `${r.status} <empty>`;
  if (typeof p === 'string') return `${r.status} ${p}`;
  if (p.error) return `${r.status} ERR ${p.error.code} ${String(p.error.message).slice(0, 300)}`;
  const res = p.result ?? {};
  const keys = Object.keys(res).sort().join(',');
  return `${r.status} OK resultType=${res.resultType ?? '-'} keys=[${keys.slice(0, 90)}]`;
};

type Case = [label: string, method: string, params?: Record<string, unknown>, opts?: any];

const CASES: Case[] = [
  ['modern tools/list', 'tools/list'],
  ['modern prompts/list', 'prompts/list'],
  ['modern resources/list', 'resources/list'],
  ['modern skills/list', 'skills/list'],
  ['modern skills/get', 'skills/get', { uri: 'skill://workouts-mcp-onboarding-wizard/SKILL.md' }],
  ['modern resources/read', 'resources/read', { uri: 'skill://workouts-mcp-onboarding-wizard/SKILL.md' }],
  ['modern prompts/get', 'prompts/get', { name: 'getting-started' }],
  ['modern server/discover', 'server/discover'],
  ['modern ping', 'ping'],
  ['modern tools/call ok', 'tools/call', { name: 'list_workouts', arguments: {} }],
  ['modern tools/call bad args', 'tools/call', { name: 'get_workout', arguments: { date: 'x', id: 'y' } }],
  ['modern tools/call unknown tool', 'tools/call', { name: 'no_such_tool', arguments: {} }],
  ['modern unknown method', 'wat/nope'],
  ['modern Mcp-Method header mismatch', 'tools/list', {}, { headers: { 'Mcp-Method': 'prompts/list' } }],
  ['modern Mcp-Method header missing', 'tools/list', {}, { headers: { 'Mcp-Method': '' } }],
  ['modern Mcp-Name mismatch', 'tools/call', { name: 'list_workouts', arguments: {} }, { headers: { 'Mcp-Name': 'other' } }],
  ['modern body _meta version missing', 'tools/list', {}, { meta: false }],
  ['modern notification (no id)', 'tools/list', {}, { id: null }],
  ['unsupported version 1999-01-01', 'tools/list', {}, { version: '1999-01-01' }],
  ['legacy initialize 2025-06-18', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, { version: null }],
  ['legacy initialize 2025-03-26', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, { version: null }],
  ['legacy initialize 2025-11-25', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, { version: null }],
  ['legacy tools/list', 'tools/list', {}, { version: null }],
  ['legacy skills/list', 'skills/list', {}, { version: null }],
  ['legacy tools/call', 'tools/call', { name: 'list_workouts', arguments: {} }, { version: null }],
  ['legacy tools/call bad args', 'tools/call', { name: 'get_workout', arguments: { date: 'x', id: 'y' } }, { version: null }],
  ['legacy unknown method', 'wat/nope', {}, { version: null }],
  ['legacy notification', 'notifications/initialized', {}, { version: null, id: null }],
  ['legacy ping', 'ping', {}, { version: null }],
];

it('prints a side-by-side of both handlers', async () => {
  const rows: string[] = [];
  for (const [label, method, params = {}, opts = {}] of CASES) {
    const a = await ask('/mcp', method, params, opts);
    const b = await ask('/sdkmcp', method, params, opts);
    const da = digest(a);
    const db = digest(b);
    rows.push(`${da === db ? 'SAME ' : 'DIFF '} ${label.padEnd(36)}\n        hand: ${da}\n        sdk : ${db}`);
  }
  const out: string[] = ['===== HAND-ROLLED /mcp  vs  AGENTS SDK /sdkmcp =====', ...rows];

  // Extra: batch, GET, and a raw legacy array body.
  const batch = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]),
  });
  const batchSdk = await SELF.fetch(`${BASE}/sdkmcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]),
  });
  out.push(`\nlegacy JSON-RPC batch  hand: ${batch.status} ${(await batch.text()).slice(0, 100)}`);
  out.push(`legacy JSON-RPC batch  sdk : ${batchSdk.status} ${(await batchSdk.text()).slice(0, 160)}`);

  const getA = await SELF.fetch(`${BASE}/mcp`, { headers: { Authorization: `Bearer ${token}` } });
  const getB = await SELF.fetch(`${BASE}/sdkmcp`, { headers: { Authorization: `Bearer ${token}` } });
  out.push(`\nGET /mcp      hand: ${getA.status} ${(await getA.text()).slice(0, 80)}`);
  out.push(`GET /sdkmcp  sdk : ${getB.status} ${(await getB.text()).slice(0, 80)}`);

  const noAcceptA = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const noAcceptB = await SELF.fetch(`${BASE}/sdkmcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  out.push(`\nlegacy POST without Accept  hand: ${noAcceptA.status} ${(await noAcceptA.text()).slice(0, 120)}`);
  out.push(`legacy POST without Accept  sdk : ${noAcceptB.status} ${(await noAcceptB.text()).slice(0, 160)}`);

  const originA = await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const originB = await SELF.fetch(`${BASE}/sdkmcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Origin: 'https://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  out.push(`\ncross-origin POST  hand: ${originA.status}`);
  out.push(`cross-origin POST  sdk : ${originB.status}`);
  throw new Error('\n' + out.join('\n') + '\n');
}, 120_000);
