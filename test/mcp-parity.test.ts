// SPIKE: what adopting the Agents SDK would and would not change, asserted.
//
// The hand-rolled handler (/mcp) and the library handler (/sdkmcp) are asked
// the same questions. The first block pins the cases where they agree; the
// second pins every case where they do NOT, so the cost of adopting is a list
// a reader can check rather than a claim. Delete with src/mcp-agents.ts if the
// spike is not taken up.

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';
const HAND = '/mcp';
const SDK = '/sdkmcp';
const V = '2026-07-28';

let token: string;
beforeEach(async () => {
  await resetDatabase();
  ({ token } = await seedUser());
});

const envelope = (version: string) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'spike', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

const NAMED_BY: Record<string, string> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

type Opts = { version?: string | null; headers?: Record<string, string>; id?: null; meta?: false };

/** One request, and the answer reduced to what a caller can actually observe. */
async function ask(path: string, method: string, params: Record<string, unknown> = {}, opts: Opts = {}) {
  const version = opts.version === undefined ? V : opts.version;
  const named = NAMED_BY[method] === undefined ? null : String(params[NAMED_BY[method]] ?? '');

  const body: Record<string, unknown> = { jsonrpc: '2.0', method };
  if (opts.id !== null) body.id = 1;
  body.params = version === null || opts.meta === false ? params : { ...params, _meta: envelope(version) };

  const response = await SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(version === null ? {} : { 'MCP-Protocol-Version': version, 'Mcp-Method': method }),
      ...(version === null || named === null ? {} : { 'Mcp-Name': named }),
      ...opts.headers,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  let parsed: Record<string, any> | null = null;
  try {
    parsed = text.includes('data: ')
      ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
      : text
        ? JSON.parse(text)
        : null;
  } catch {
    parsed = null;
  }

  return {
    status: response.status,
    code: parsed?.error?.code as number | undefined,
    // Result field names, which is where an era shows itself (resultType, cache hints).
    keys: parsed?.result ? Object.keys(parsed.result).sort() : undefined,
    isError: parsed?.result?.isError as boolean | undefined,
    result: parsed?.result as Record<string, any> | undefined,
  };
}

const both = async (method: string, params: Record<string, unknown> = {}, opts: Opts = {}) => ({
  hand: await ask(HAND, method, params, opts),
  sdk: await ask(SDK, method, params, opts),
});

const LEGACY: Opts = { version: null };
const SKILL = 'skill://workouts-mcp-onboarding-wizard/SKILL.md';

describe('the library answers exactly as the hand-rolled handler does', () => {
  const identical: Array<[string, string, Record<string, unknown>?, Opts?]> = [
    ['modern tools/list', 'tools/list'],
    ['modern prompts/list', 'prompts/list'],
    ['modern resources/list', 'resources/list'],
    ['modern prompts/get', 'prompts/get', { name: 'getting-started' }],
    ['modern resources/read', 'resources/read', { uri: SKILL }],
    ['modern server/discover', 'server/discover'],
    ['modern skills/list', 'skills/list'],
    ['modern skills/get', 'skills/get', { uri: SKILL }],
    ['modern tools/call', 'tools/call', { name: 'list_workouts', arguments: {} }],
    ['legacy initialize 2025-06-18', 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, LEGACY],
    ['legacy initialize 2025-03-26', 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, LEGACY],
    ['legacy initialize 2025-11-25', 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'x', version: '1' } }, LEGACY],
    ['legacy tools/list', 'tools/list', {}, LEGACY],
    ['legacy skills/list', 'skills/list', {}, LEGACY],
    ['legacy tools/call', 'tools/call', { name: 'list_workouts', arguments: {} }, LEGACY],
    ['legacy ping', 'ping', {}, LEGACY],
  ];

  for (const [label, method, params, opts] of identical) {
    it(`agrees on ${label}`, async () => {
      const { hand, sdk } = await both(method, params, opts);
      expect(sdk.status, label).toBe(hand.status);
      expect(sdk.keys, label).toEqual(hand.keys);
      expect(sdk.code, label).toBe(hand.code);
    });
  }

  it('agrees that a notification is answered with nothing', async () => {
    const { hand, sdk } = await both('tools/list', {}, { id: null });
    expect(hand.status).toBe(202);
    expect(sdk.status).toBe(202);
  });

  it('agrees on the same JSON-RPC code for every protocol refusal', async () => {
    const refusals: Array<[string, string, Record<string, unknown>, Opts]> = [
      ['Mcp-Method mismatch', 'tools/list', {}, { headers: { 'Mcp-Method': 'prompts/list' } }],
      ['Mcp-Name mismatch', 'tools/call', { name: 'list_workouts', arguments: {} }, { headers: { 'Mcp-Name': 'other' } }],
      ['unsupported version', 'tools/list', {}, { version: '1999-01-01' }],
      ['unknown method', 'wat/nope', {}, {}],
    ];
    for (const [label, method, params, opts] of refusals) {
      const { hand, sdk } = await both(method, params, opts);
      expect(sdk.code, label).toBe(hand.code);
      expect(sdk.status, label).toBe(hand.status);
    }
  });

  it('decodes a base64-encoded Mcp-Name, as docs/mcp.md describes', async () => {
    const encoded = `=?base64?${btoa('list_workouts')}?=`;
    const opts = { headers: { 'Mcp-Name': encoded } };
    const { hand, sdk } = await both('tools/call', { name: 'list_workouts', arguments: {} }, opts);
    expect(hand.status).toBe(200);
    expect(sdk.status).toBe(200);
    expect(sdk.isError).toBeUndefined();
  });

  it('keeps the error messages src/tools.ts writes for the model', async () => {
    // The SDK would validate against the JSON Schema first and answer in
    // schema prose; `advertiseOnly` in src/mcp-agents.ts stops it, so the
    // athlete-facing wording survives. This is the assertion that pins that.
    const args = { date: '2026-09-20', name: 'Easy', sport: 'quidditch', steps: [{ name: 'Run', goal_s: 60 }] };
    const { hand, sdk } = await both('tools/call', { name: 'create_workout', arguments: args });
    expect(hand.isError).toBe(true);
    expect(sdk.isError).toBe(true);
    expect(sdk.result!.content[0].text).toBe(hand.result!.content[0].text);
    expect(sdk.result!.content[0].text).toContain('unknown sport "quidditch"');
  });
});

describe('what adopting the library would change', () => {
  it('drops ping on 2026-07-28, which the revision removed and we still answer', async () => {
    const { hand, sdk } = await both('ping');
    expect(hand.status).toBe(200);
    expect(sdk.status).toBe(404);
    expect(sdk.code).toBe(-32601);
  });

  it('turns an unknown tool into a JSON-RPC error instead of a retryable isError', async () => {
    const { hand, sdk } = await both('tools/call', { name: 'no_such_tool', arguments: {} });
    expect(hand.isError).toBe(true);
    expect(sdk.code).toBe(-32602);
  });

  it('refuses a legacy POST that does not accept text/event-stream', async () => {
    const send = (path: string) =>
      SELF.fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
    expect((await send(HAND)).status).toBe(200);
    expect((await send(SDK)).status).toBe(406);
  });

  it('reports a header/body version disagreement as a mismatch, not an unsupported version', async () => {
    // Both faults are real when the header and the body name different
    // revisions. src/mcp.ts deliberately reports the unsupported version
    // first — the ordering it had to adopt after a real client was told
    // "header mismatch" and could not act on it. The library reports the
    // mismatch. Adopting it reintroduces that ordering.
    const opts = { headers: { 'MCP-Protocol-Version': '1999-01-01' } };
    const { hand, sdk } = await both('tools/list', {}, opts);
    expect(hand.code).toBe(-32022);
    expect(sdk.code).toBe(-32020);
  });

  it('reports a missing per-request envelope as invalid params, not a header mismatch', async () => {
    const { hand, sdk } = await both('tools/list', {}, { meta: false });
    expect(hand.code).toBe(-32020);
    expect(sdk.code).toBe(-32602);
  });
});

describe('the envelope the 2026-07-28 revision actually requires', () => {
  // The library rejects what src/mcp.ts accepts: the revision requires
  // clientInfo and clientCapabilities per request, and src/mcp.ts checks only
  // protocolVersion. This is a conformance gap in the hand-rolled handler, and
  // it is fixable there without adopting anything.
  const partial = async (path: string) => {
    const response = await SELF.fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': V,
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V } },
      }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };

  it('is enforced by the library and not by src/mcp.ts', async () => {
    const hand = await partial(HAND);
    const sdk = await partial(SDK);
    expect(hand.status).toBe(200);
    expect(sdk.status).toBe(400);
    expect(sdk.body.error.message).toContain('clientCapabilities');
  });
});
