import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { listPrompts } from '../src/prompts';
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
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

const VERSION = '2026-07-28';

/** Which body field `Mcp-Name` mirrors, as the server expects it to. */
const NAMED_BY: Record<string, string> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

type Options = { id?: number | null; headers?: Record<string, string>; version?: string };

/** A well-formed request: the metadata in the body, and the headers that mirror it. */
async function post(
  method: string,
  params: Record<string, unknown> = {},
  options: Options = {},
): Promise<Response> {
  const version = options.version ?? VERSION;
  const named = NAMED_BY[method] === undefined ? null : String(params[NAMED_BY[method]] ?? '');

  return await SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': version,
      'Mcp-Method': method,
      ...(named === null ? {} : { 'Mcp-Name': named }),
      ...options.headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(options.id === null ? {} : { id: options.id ?? 1 }),
      method,
      params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version } },
    }),
  });
}

/** A request from the era this no longer serves: no metadata, no mirrored headers. */
const legacy = (body: unknown): Promise<Response> =>
  SELF.fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function rpc(method: string, params: Record<string, unknown> = {}, options: Options = {}): Promise<RpcResult> {
  const response = await post(method, params, options);
  const text = await response.text();
  return text ? (JSON.parse(text) as RpcResult) : ({} as RpcResult);
}

/** Call a tool and return its structured result, asserting it did not error. */
async function callTool(name: string, args: unknown): Promise<Record<string, unknown>> {
  const response = await rpc('tools/call', { name, arguments: args });
  expect(response.result?.isError, JSON.stringify(response.result)).toBeFalsy();
  return response.result?.structuredContent as Record<string, unknown>;
}

describe('protocol', () => {
  it('tells a handshake client what it needs, rather than "unknown method"', async () => {
    // It has no fall-forward, so this error is the only diagnostic it will surface.
    const response = await legacy({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const body = (await response.json()) as RpcResult;

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code: -32022 });
    expect(body.error?.data).toMatchObject({ supported: ['2026-07-28'] });
    expect(body.error?.message).toContain('2026-07-28');
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

    expect(readOnly.sort()).toEqual([
      'export_workout_fit',
      'get_current_plan',
      'get_onboarding_instructions',
      'get_scheduling_instructions',
      'get_workout',
      'get_workout_library',
      'get_workout_stats',
      'get_workout_zones',
      'list_recorded_workouts',
      'list_workouts',
    ]);
    expect(destructive.sort()).toEqual(['delete_workout', 'update_context', 'update_workout']);
    // Completing and commenting are writes, but neither can lose the plan it is recorded against.
    for (const name of ['complete_workout', 'comment_workout']) {
      expect(tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    }
    // Every tool says which it is, rather than leaving a client to guess.
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBeTypeOf('boolean');
  });

  it('offers its prompts, with the bodies left behind prompts/get', async () => {
    expect((await rpc('server/discover')).result).toMatchObject({
      capabilities: { prompts: { listChanged: false } },
    });

    const { prompts } = (await rpc('prompts/list')).result as {
      prompts: { name: string; title: string; description: string }[];
    };
    expect(prompts).toEqual(listPrompts());
    expect(prompts.map((prompt) => prompt.name)).toContain('getting-started');
    for (const prompt of prompts) {
      expect(prompt.title).toBeTruthy();
      expect(prompt.description).toBeTruthy();
      expect(prompt).not.toHaveProperty('markdown');
    }
  });

  it('hands back the getting-started interview as one message from the athlete', async () => {
    const result = (await rpc('prompts/get', { name: 'getting-started' })).result as {
      messages: { role: string; content: { type: string; text: string } }[];
    };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe('user');

    const text = result.messages[0].content.text;
    // It has to end with all three documents written, and it can only do that by
    // reading them first and calling the one tool that writes them.
    for (const kind of ['workout-zones', 'scheduling-instructions', 'current-plan']) {
      expect(text).toContain(kind);
    }
    for (const tool of ['get_workout_zones', 'get_scheduling_instructions', 'get_current_plan', 'update_context']) {
      expect(text).toContain(tool);
    }
  });

  it('rejects a prompt it does not have', async () => {
    expect((await rpc('prompts/get', { name: 'nope' })).error).toMatchObject({ code: -32602 });
  });

  it('hands over the interview only when something asks for it', async () => {
    // Not in server/discover: a client pays for the tool list, not for a setup
    // that happened months ago.
    expect((await rpc('server/discover')).result).not.toHaveProperty('instructions');

    const { markdown } = (await callTool('get_onboarding_instructions', {})) as { markdown: string };
    expect(markdown).toContain('Round 1 — sport and goal');
    expect(markdown).toContain('Never invent a number');
    // The prompt and the tool are the same body, reached two ways.
    const prompt = (await rpc('prompts/get', { name: 'getting-started' })).result as {
      messages: { content: { text: string } }[];
    };
    expect(prompt.messages[0].content.text).toBe(markdown);
  });

  it('says what to do about an empty document in the read itself', async () => {
    const empty = await callTool('get_current_plan', {});
    expect(empty.markdown).toBeNull();
    // Nothing else tells a caller the interview exists, so this names the tool.
    expect(empty.next_step).toContain('get_onboarding_instructions');

    await callTool('update_context', { kind: 'current-plan', markdown: '# Plan\nSub-60 10K.' });
    // Gone once there is something there, rather than null on every read forever.
    expect(await callTool('get_current_plan', {})).not.toHaveProperty('next_step');
    // The library always has its built-in document, so it never asks for one.
    expect(await callTool('get_workout_library', {})).not.toHaveProperty('next_step');
  });

  it('answers a ping, and an unknown method with a 404', async () => {
    expect((await rpc('ping')).result).toMatchObject({ resultType: 'complete' });

    // The status is contract: it is how a client tells a live endpoint from an empty URL.
    const unknown = await post('what/ever');
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as RpcResult).error).toMatchObject({ code: -32601 });
  });

  it('returns nothing for a notification', async () => {
    expect((await post('ping', {}, { id: null })).status).toBe(202);
  });

  it('refuses a body that is not a single request object', async () => {
    // One message per POST: a batch was an affordance of the era this no longer serves.
    for (const body of ['null', '[]', '{"jsonrpc":"2.0","id":1}']) {
      const response = await SELF.fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': VERSION,
          'Mcp-Method': 'tools/list',
        },
        body,
      });
      expect(response.status, body).toBe(400);
      expect(((await response.json()) as RpcResult).error, body).toMatchObject({ code: -32600 });
    }
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

describe('the wire', () => {
  it('answers server/discover with the version it serves', async () => {
    const { result } = await rpc('server/discover');

    expect(result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, prompts: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'workout-mcp' } },
    });
  });

  it('carries caching hints on the lists, and shares them because they are nobody in particular', async () => {
    for (const method of ['server/discover', 'tools/list', 'prompts/list']) {
      const { result } = await rpc(method);
      // Every one of these is built from code, so one athlete's copy is every athlete's.
      expect(result, method).toMatchObject({ resultType: 'complete', cacheScope: 'public' });
      expect(result?.ttlMs, method).toBeGreaterThan(0);
    }
    // Not a cacheable operation, so it says nothing about freshness — but it still
    // says what kind of result it is.
    const called = (await rpc('tools/call', { name: 'list_workouts', arguments: {} })).result;
    expect(called).not.toHaveProperty('ttlMs');
    expect(called).toMatchObject({ resultType: 'complete' });
  });

  it('says what kind of result it is, on every result', async () => {
    // The revision requires it on all of them. An absent one is read as complete only
    // from an older server, so a client is right to refuse it from this one.
    const methods = ['server/discover', 'ping', 'tools/list', 'prompts/list', 'resources/list', 'skills/list'];
    for (const method of methods) {
      expect((await rpc(method)).result, method).toMatchObject({ resultType: 'complete' });
    }

    expect((await rpc('prompts/get', { name: 'getting-started' })).result).toMatchObject({
      resultType: 'complete',
    });
    // Including the one a refused tool call comes back as.
    const refused = (await rpc('tools/call', { name: 'get_workout', arguments: { date: 'nope' } })).result;
    expect(refused).toMatchObject({ resultType: 'complete', isError: true });
  });

  it('names itself on every result, without anything having to remember a handshake', async () => {
    for (const method of ['ping', 'tools/list', 'server/discover']) {
      expect((await rpc(method)).result?._meta, method).toMatchObject({
        'io.modelcontextprotocol/serverInfo': { name: 'workout-mcp' },
      });
    }
  });

  it('refuses a version it does not serve, and says which it does', async () => {
    const response = await post('tools/list', {}, { version: '1900-01-01' });
    const body = (await response.json()) as RpcResult;

    expect(response.status).toBe(400);
    expect(body.error).toMatchObject({ code: -32022 });
    expect(body.error?.data).toMatchObject({ supported: ['2026-07-28'], requested: '1900-01-01' });
  });

  it('checks the headers against the body, on every request that claims the modern era', async () => {
    // A proxy routing on the header and this Worker acting on the body is the split the rule closes.
    const cases: Array<[string, Record<string, string>]> = [
      ['a method that is not the one in the body', { 'Mcp-Method': 'tools/call' }],
      ['no mirrored method at all', { 'Mcp-Method': '' }],
    ];
    for (const [what, headers] of cases) {
      const response = await post('tools/list', {}, { headers });
      expect(response.status, what).toBe(400);
      expect(((await response.json()) as RpcResult).error, what).toMatchObject({ code: -32020 });
    }

    // A header naming this era over a body naming another: the routing believed the
    // header, and the body has to agree with it before anything is done.
    const twoVersions = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': VERSION,
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } },
      }),
    });
    expect(twoVersions.status).toBe(400);
    expect(((await twoVersions.json()) as RpcResult).error).toMatchObject({ code: -32020 });

    const wrongName = await post(
      'tools/call',
      { name: 'list_workouts', arguments: {} },
      { headers: { 'Mcp-Name': 'delete_workout' } },
    );
    expect(wrongName.status).toBe(400);
    expect(((await wrongName.json()) as RpcResult).error).toMatchObject({ code: -32020 });
  });

  it('cannot be talked out of that validation by leaving the body metadata off', async () => {
    // The era is read off the header, so a request claiming the modern one is checked
    // whatever the body says. Choosing from the body is what let this be skipped.
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': VERSION,
        'Mcp-Method': 'tools/list',
        'Mcp-Name': 'list_workouts',
      },
      // Headers a gateway would route on; a body that does something else entirely.
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} }),
    });

    expect(response.status).toBe(400);
    expect(((await response.json()) as RpcResult).error).toMatchObject({ code: -32020 });
  });

  it('reads a name the ASCII range cannot carry', async () => {
    const encoded = `=?base64?${btoa('list_workouts')}?=`;
    const response = await post(
      'tools/call',
      { name: 'list_workouts', arguments: {} },
      { headers: { 'Mcp-Name': encoded } },
    );

    expect(response.status).toBe(200);
  });

  it('keeps a tool refusing its input a successful call, and its own faults a 5xx', async () => {
    // The model reads the message and retries, so this is a 200 carrying isError.
    const refused = await post('tools/call', { name: 'get_workout', arguments: { date: 'nope' } });
    expect(refused.status).toBe(200);
    expect(((await refused.json()) as RpcResult).result).toMatchObject({ isError: true });
  });
});

describe('the interview as a skill', () => {
  const URI = 'skill://workouts-mcp-onboarding-wizard/SKILL.md';

  type Entry = {
    uri: string;
    frontmatter: { name: string; description: string };
    resources: Array<{ uri: string; digest: string; size: number }>;
  };

  it('declares the extension, and the resources it is built on', async () => {
    const { result } = await rpc('server/discover');

    expect(result?.capabilities).toMatchObject({
      resources: {},
      extensions: { 'io.modelcontextprotocol/skills': {} },
    });
  });

  it('lists the skill with a complete manifest', async () => {
    const { skills } = (await rpc('skills/list')).result as { skills: Entry[] };

    expect(skills).toHaveLength(1);
    expect(skills[0].uri).toBe(URI);
    expect(skills[0].frontmatter.name).toBe('workouts-mcp-onboarding-wizard');
    expect(skills[0].frontmatter.description).toBeTruthy();
    // A manifest must name SKILL.md and every supporting file.
    expect(skills[0].resources.map((file) => file.uri)).toEqual([URI]);
  });

  it('serves bytes a host can verify against the manifest, and frontmatter that matches', async () => {
    const { skills } = (await rpc('skills/list')).result as { skills: Entry[] };
    const [file] = skills[0].resources;

    const { contents } = (await rpc('resources/read', { uri: URI })).result as {
      contents: { uri: string; mimeType: string; text: string }[];
    };
    const text = contents[0].text;

    // What a host does before it loads anything: size, digest, then frontmatter.
    const bytes = new TextEncoder().encode(text);
    expect(bytes.length).toBe(file.size);

    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    expect(`sha256:${hex}`).toBe(file.digest);

    // The frontmatter opens the file and says what the entry said.
    expect(text.startsWith('---\n')).toBe(true);
    const front = text.slice(4, text.indexOf('\n---\n'));
    expect(front).toContain(`name: "${skills[0].frontmatter.name}"`);
    expect(front).toContain(JSON.stringify(skills[0].frontmatter.description));
    // And the interview itself is underneath it.
    expect(text).toContain('Round 1 — sport and goal');
  });

  it('answers skills/get by uri, and refuses one it does not serve', async () => {
    const { result } = await rpc('skills/get', { uri: URI });
    expect((result as { skill: Entry }).skill.uri).toBe(URI);

    expect((await rpc('skills/get', { uri: 'skill://nope/SKILL.md' })).error).toMatchObject({ code: -32602 });
    expect((await rpc('resources/read', { uri: 'skill://nope/SKILL.md' })).error).toMatchObject({ code: -32602 });
  });

  it('serves the same interview as the prompt and the tool do', async () => {
    const { contents } = (await rpc('resources/read', { uri: URI })).result as {
      contents: { text: string }[];
    };
    const { markdown } = (await callTool('get_onboarding_instructions', {})) as { markdown: string };

    // One body, four doors: the skill adds frontmatter and nothing else.
    expect(contents[0].text.endsWith(markdown)).toBe(true);
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

  it('exports FIT bytes inline, named after the workout', async () => {
    const created = await callTool('create_workout', intervals);
    const exported = (await callTool('export_workout_fit', { date: created.date, id: created.id })) as {
      filename: string;
      base64: string;
      bytes: number;
    };

    expect(exported.filename).toBe(`${DAY}-8x400m.fit`);
    expect(exported.bytes).toBeGreaterThan(0);
    // ".FIT" is the type signature at bytes 8-11 of every FIT file header.
    expect(atob(exported.base64).slice(8, 12)).toBe('.FIT');
  });

  /*
   * A model handed a fit_url links to it rather than calling the tool, and the
   * link is no use to whoever it is handed to: the bytes sit behind the
   * caller's own credential. So no tool result mentions a URL at all.
   */
  it('never hands the model a URL to fetch or link', async () => {
    const created = await callTool('create_workout', intervals);
    const results = [
      created,
      await callTool('get_workout', { date: DAY, id: created.id }),
      await callTool('list_workouts', {}),
      await callTool('update_workout', { id: created.id, current_date: DAY, ...intervals }),
      await callTool('export_workout_fit', { date: DAY, id: created.id }),
    ];

    for (const result of results) {
      expect(JSON.stringify(result)).not.toMatch(/_url|https?:/);
    }
  });

  it('marks a workout done, at a time it is given', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };

    const done = (await callTool('complete_workout', {
      date: DAY,
      id: created.id,
      completed_at: `${DAY}T06:30:00Z`,
    })) as { completed_at: string };
    expect(done.completed_at).toBe(`${DAY}T06:30:00.000Z`);

    const read = (await callTool('get_workout', { date: DAY, id: created.id })) as { completed_at: string };
    expect(read.completed_at).toBe(`${DAY}T06:30:00.000Z`);
  });

  it('marks a workout done as of now when no time is given', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    const before = Date.now();
    const done = (await callTool('complete_workout', { date: DAY, id: created.id })) as { completed_at: string };
    expect(Date.parse(done.completed_at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('clears the record on completed: false, leaving the plan alone', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    await callTool('complete_workout', { date: DAY, id: created.id });

    const cleared = (await callTool('complete_workout', {
      date: DAY,
      id: created.id,
      completed: false,
    })) as Record<string, unknown>;
    expect(cleared).not.toHaveProperty('completed_at');

    const read = (await callTool('get_workout', { date: DAY, id: created.id })) as { steps: unknown[] };
    expect(read.steps).toHaveLength(intervals.steps.length);
  });

  it('refuses a time alongside completed: false, rather than guessing', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    const response = await rpc('tools/call', {
      name: 'complete_workout',
      arguments: { date: DAY, id: created.id, completed: false, completed_at: `${DAY}T06:30:00Z` },
    });
    expect(response.result?.isError).toBe(true);
  });

  it('keeps the record when the plan is replaced or moved', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    await callTool('complete_workout', { date: DAY, id: created.id, completed_at: `${DAY}T06:30:00Z` });

    await callTool('update_workout', { id: created.id, current_date: DAY, ...intervals, date: NEXT_DAY });

    const read = (await callTool('get_workout', { date: NEXT_DAY, id: created.id })) as { completed_at: string };
    expect(read.completed_at).toBe(`${DAY}T06:30:00.000Z`);
  });

  it('records the athlete’s note on how a session went, and hands it back', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };

    const commented = (await callTool('comment_workout', {
      date: DAY,
      id: created.id,
      comment: '  Legs flat from Sunday. Cut the last two reps.  ',
    })) as { comment: string };
    expect(commented.comment).toBe('Legs flat from Sunday. Cut the last two reps.');

    const read = (await callTool('get_workout', { date: DAY, id: created.id })) as { comment: string };
    expect(read.comment).toBe('Legs flat from Sunday. Cut the last two reps.');
  });

  it('clears the note on an empty comment', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    await callTool('comment_workout', { date: DAY, id: created.id, comment: 'Said something' });

    const cleared = (await callTool('comment_workout', {
      date: DAY,
      id: created.id,
      comment: '',
    })) as Record<string, unknown>;
    expect(cleared).not.toHaveProperty('comment');
  });

  // Its own verb, like completing: the plan is rewritten under it and the note stands.
  it('keeps the note when the plan is replaced or moved', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    await callTool('comment_workout', { date: DAY, id: created.id, comment: 'Survives' });

    await callTool('update_workout', { id: created.id, current_date: DAY, ...intervals, date: NEXT_DAY });

    const read = (await callTool('get_workout', { date: NEXT_DAY, id: created.id })) as { comment: string };
    expect(read.comment).toBe('Survives');
  });

  it('refuses a comment longer than the column is meant to hold', async () => {
    const created = (await callTool('create_workout', intervals)) as { id: string };
    const response = await rpc('tools/call', {
      name: 'comment_workout',
      arguments: { date: DAY, id: created.id, comment: 'x'.repeat(2001) },
    });
    expect(response.result?.isError).toBe(true);
  });

  it('reports commenting on a workout that is not there', async () => {
    const response = await rpc('tools/call', {
      name: 'comment_workout',
      arguments: { date: DAY, id: 'nosuchid1', comment: 'hello' },
    });
    expect(response.result?.isError).toBe(true);
  });

  it('reports completing a workout that is not there', async () => {
    const response = await rpc('tools/call', {
      name: 'complete_workout',
      arguments: { date: DAY, id: 'nosuchid1' },
    });
    expect(response.result?.isError).toBe(true);
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
