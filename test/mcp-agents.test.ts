// SPIKE: the same protocol surface as test/mcp.test.ts, against the Agents SDK
// route mounted at /sdkmcp. Answers the four spike questions empirically.

import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { TOOLS } from '../src/tools';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';
const PATH = '/sdkmcp';
const MODERN = '2026-07-28';
const LEGACY = '2025-06-18';

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

async function modern(method: string, params: Record<string, unknown> = {}, version = MODERN) {
  const named = NAMED_BY[method] === undefined ? null : String(params[NAMED_BY[method]] ?? '');
  const response = await SELF.fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(named === null ? {} : { 'Mcp-Name': named }),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': version,
          'io.modelcontextprotocol/clientInfo': { name: 'spike', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
}

async function legacy(method: string, params: Record<string, unknown> = {}) {
  const response = await SELF.fetch(`${BASE}${PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  // The legacy lane may answer as SSE; unwrap the single data frame if so.
  const json = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))!.slice(6))
    : text ? JSON.parse(text) : null;
  return { status: response.status, text, body: json };
}

describe('Q1 — OAuth props reach the handler', () => {
  it('rejects an unauthenticated request before the handler', async () => {
    const response = await SELF.fetch(`${BASE}${PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('calls a tool as the athlete the wk_ token identifies', async () => {
    const { status, body } = await modern('tools/call', { name: 'list_workouts', arguments: {} });
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
    expect(body.result.isError).toBeUndefined();
  });
});

describe('Q2 — both eras', () => {
  it('answers the modern era with resultType and serverInfo', async () => {
    const { status, body } = await modern('tools/list');
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
    expect(body.result._meta?.['io.modelcontextprotocol/serverInfo']).toBeDefined();
    expect(body.result.tools).toHaveLength(TOOLS.length);
  });

  it('answers server/discover', async () => {
    const { body } = await modern('server/discover');
    expect(body.result.supportedVersions).toContain(MODERN);
  });

  it('answers the legacy initialize handshake', async () => {
    const { status, body } = await legacy('initialize', {
      protocolVersion: LEGACY,
      capabilities: {},
      clientInfo: { name: 'spike', version: '1' },
    });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe(LEGACY);
    expect(body.result.serverInfo.name).toBe('workout-mcp');
  });

  it('answers a legacy tools/list', async () => {
    const { body } = await legacy('tools/list');
    expect(body.result.tools).toHaveLength(TOOLS.length);
    expect(body.result.resultType).toBeUndefined();
  });

  it('applies cache hints on the modern era', async () => {
    const { body } = await modern('tools/list');
    expect(body.result.cacheScope).toBe('public');
    expect(body.result.ttlMs).toBe(300_000);
  });
});

describe('Q3 — the Skills extension', () => {
  it('advertises the extension on server/discover', async () => {
    const { body } = await modern('server/discover');
    expect(body.result.capabilities?.extensions).toHaveProperty('io.modelcontextprotocol/skills');
  });

  it('answers skills/list', async () => {
    const { status, body } = await modern('skills/list');
    expect(status).toBe(200);
    expect(body.result?.skills?.[0]?.uri).toBe('skill://workouts-mcp-onboarding-wizard/SKILL.md');
  });

  it('answers skills/get', async () => {
    const { body } = await modern('skills/get', { uri: 'skill://workouts-mcp-onboarding-wizard/SKILL.md' });
    expect(body.result?.skill?.resources?.[0]?.digest).toMatch(/^sha256:/);
  });

  it('reads the skill file back over resources/read', async () => {
    const { body } = await modern('resources/read', { uri: 'skill://workouts-mcp-onboarding-wizard/SKILL.md' });
    expect(body.result?.contents?.[0]?.text).toContain('name: "workouts-mcp-onboarding-wizard"');
  });
});

describe('Q — errors', () => {
  it('reports a bad tool argument as a successful call carrying isError', async () => {
    const { status, body } = await modern('tools/call', {
      name: 'get_workout',
      arguments: { date: 'not-a-date', id: 'nope' },
    });
    expect(status).toBe(200);
    expect(body.result.isError).toBe(true);
  });

  it('refuses an unsupported protocol version', async () => {
    const { status, body } = await modern('tools/list', {}, '1999-01-01');
    expect(status).toBeGreaterThanOrEqual(400);
    expect(body.error?.message).toMatch(/version/i);
  });
});

describe('the repo\'s real schemas through the SDK validator', () => {
  it('creates a workout with nested repeats, oneOf targets and union types', async () => {
    const { status, body } = await modern('tools/call', {
      name: 'create_workout',
      arguments: {
        date: '2026-09-20',
        name: '8x400m',
        sport: 'running',
        steps: [
          { name: 'Warmup', goal_s: 600, target_heart_rate: [146, 153] },
          {
            repeat: 8,
            steps: [
              { name: 'Fast', goal_meters: 400, target_pace_km: ['4:00', '4:15'] },
              { name: 'Float', goal_s: 90, target_pace_km: ['-', '6:30'] },
            ],
          },
          { name: 'Cooldown', goal_s: '10:00', target_hr_zone: ['2', '3'] },
        ],
      },
    });
    expect(status).toBe(200);
    expect(body.result.isError, JSON.stringify(body.result).slice(0, 400)).toBeUndefined();
    expect(body.result.structuredContent.name).toBe('8x400m');
  });

  it('reads it back and exports it as FIT', async () => {
    await modern('tools/call', {
      name: 'create_workout',
      arguments: { date: '2026-09-20', name: 'Easy', sport: 'running', steps: [{ name: 'Run', goal_s: 1800 }] },
    });
    const list = await modern('tools/call', { name: 'list_workouts', arguments: {} });
    const id = list.body.result.structuredContent.workouts[0].id;
    const fit = await modern('tools/call', { name: 'export_workout_fit', arguments: { date: '2026-09-20', id } });
    expect(fit.body.result.isError, JSON.stringify(fit.body.result).slice(0, 300)).toBeUndefined();
    expect(fit.body.result.structuredContent.filename).toMatch(/\.fit$/);
  });
});
