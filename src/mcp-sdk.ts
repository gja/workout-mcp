// SPIKE ONLY — the same MCP surface on MCP SDK v2's own `createMcpHandler`,
// with no `agents` dependency. `agents/mcp/server` is a 317-line wrapper over
// this: route match, CORS, Host/Origin checks, and an AsyncLocalStorage that
// carries the OAuth props. A Worker that only serves MCP needs none of that —
// the props are already on `ctx`, so they go in by closure and `nodejs_compat`
// is not required. Mounted beside `src/mcp.ts`. See docs/mcp.md.

import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { ONBOARDING, promptMessages } from './prompts';
import { SKILLS_EXTENSION, findSkill, listResources, listSkills, readResource } from './skills';
import { TOOLS, callTool, isCallerError } from './tools';
import type { Env, User } from './db';

const SERVER_INFO = { name: 'workout-mcp', version: '0.1.0' };

/**
 * Advertises the tool's JSON Schema in `tools/list` but never rejects on it.
 * `fromJsonSchema` would validate first and answer in JSON-Schema prose
 * ("#/steps: Items did not match schema."), replacing the messages
 * `src/tools.ts` writes for the model ("unknown field target_zone; allowed:
 * goal_km, goal_meters, ..."). The schema is the contract a model reads; the
 * repo's own parser is what tells it what went wrong.
 */
const advertiseOnly = (schema: Record<string, unknown>) => {
  const standard = fromJsonSchema(schema);
  return {
    ...standard,
    '~standard': { ...standard['~standard'], validate: (value: unknown) => ({ value }) },
  } as typeof standard;
};

/**
 * `cacheHints` covers only the SDK's closed list of cacheable methods, so a
 * custom method has to emit them itself — and has to know the era, because the
 * 2025 revision has no cache fields. The library's era-blindness stops at the
 * edge of its own vocabulary.
 */
const CUSTOM_CACHE_HINT = (era: 'legacy' | 'modern') =>
  era === 'modern' ? { ttlMs: 300_000, cacheScope: 'public' as const } : {};

function buildServer(env: Env, user: User, origin: string, era: 'legacy' | 'modern'): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false },
    },
    cacheHints: {
      'tools/list': { ttlMs: 300_000, cacheScope: 'public' },
      'prompts/list': { ttlMs: 300_000, cacheScope: 'public' },
      'resources/list': { ttlMs: 300_000, cacheScope: 'public' },
      'resources/read': { ttlMs: 300_000, cacheScope: 'public' },
      'server/discover': { ttlMs: 300_000, cacheScope: 'public' },
    },
  });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: advertiseOnly(tool.inputSchema as Record<string, unknown>),
      },
      async (args) => {
        try {
          const result = await callTool(tool.name, args, env, user, origin);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          if (isCallerError(error)) {
            return { content: [{ type: 'text' as const, text: error.message }], isError: true };
          }
          throw error;
        }
      },
    );
  }

  server.registerPrompt(
    ONBOARDING.name,
    { title: ONBOARDING.title, description: ONBOARDING.description },
    () => promptMessages(ONBOARDING) as never,
  );

  for (const resource of listResources()) {
    server.registerResource(
      resource.name,
      resource.uri,
      { mimeType: resource.mimeType, cacheHint: { ttlMs: 300_000, cacheScope: 'public' } },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readResource(uri.href) ?? '' }],
      }),
    );
  }

  // The Skills extension has no first-class support in either SDK, so the two
  // methods are registered as custom ones. `params` is required and must be a
  // Standard Schema, hence `fromJsonSchema` on a hand-written JSON Schema.
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } } as never);

  server.server.setRequestHandler(
    'skills/list',
    { params: fromJsonSchema({ type: 'object', additionalProperties: true }) },
    async () => ({ ...CUSTOM_CACHE_HINT(era), skills: await listSkills() }),
  );

  server.server.setRequestHandler(
    'skills/get',
    {
      params: fromJsonSchema({
        type: 'object',
        properties: { uri: { type: 'string' } },
        required: ['uri'],
        additionalProperties: true,
      }),
    },
    async (params) => {
      const skill = await findSkill((params as { uri?: string })?.uri);
      if (!skill) throw new Error(`no skill at "${String((params as { uri?: string })?.uri ?? '')}"`);
      return { ...CUSTOM_CACHE_HINT(era), skill };
    },
  );

  return server;
}

/**
 * One handler per request: the factory closes over the athlete, so there is
 * nothing to memoise and nothing to carry the identity in. `close()` releases
 * the modern leg; the legacy lane holds nothing between exchanges.
 */
export async function handleMcpWithSdk(request: Request, env: Env, user: User): Promise<Response> {
  const origin = new URL(request.url).origin;
  const handler = createMcpHandler((mcpCtx) => buildServer(env, user, origin, mcpCtx.era));

  try {
    const response = await handler.fetch(request);
    // The hand-rolled handler answers every origin; match it.
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    await handler.close().catch(() => {});
  }
}
