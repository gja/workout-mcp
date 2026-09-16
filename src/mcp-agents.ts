// SPIKE ONLY — the same MCP surface, served by Cloudflare's Agents SDK
// (`createMcpHandler`) on top of MCP SDK v2, mounted beside the hand-rolled
// `src/mcp.ts` for comparison. Not wired into production. See docs/mcp.md.

import { createMcpHandler, getMcpAuthContext } from 'agents/mcp/server';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { ONBOARDING, promptMessages } from './prompts';
import { SKILLS_EXTENSION, findSkill, listResources, listSkills, readResource } from './skills';
import { TOOLS, callTool, isCallerError } from './tools';
import type { Env, User } from './db';

type AuthProps = { userId: string; email: string | null };

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

/**
 * The library hands the factory an era, the Request and `authInfo` — but never
 * `env`. The Worker binding has to arrive by closure, so the handler is built
 * per `env` object and memoised on it.
 */
const handlers = new WeakMap<object, ReturnType<typeof createMcpHandler>>();

function buildServer(env: Env, origin: string, era: 'legacy' | 'modern'): McpServer {
  const props = getMcpAuthContext()?.props as AuthProps | undefined;
  const user: User = { id: props?.userId ?? '', email: props?.email ?? null };

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

export function handleMcpWithAgents(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let handler = handlers.get(env as object);
  if (!handler) {
    handler = createMcpHandler(
      (mcpCtx) =>
        buildServer(env, new URL(mcpCtx.requestInfo?.url ?? request.url).origin, mcpCtx.era),
      {
        route: '/sdkmcp',
        // Match the hand-rolled handler, which does no Origin validation and
        // answers every origin. The library's default would reject a browser
        // Origin on a custom domain.
        allowedOriginHostnames: '*',
        corsOptions: { origin: '*' },
      },
    );
    handlers.set(env as object, handler);
  }
  return handler(request, env, ctx);
}
