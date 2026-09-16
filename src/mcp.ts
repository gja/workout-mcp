// MCP over Streamable HTTP, in both eras, served by the official SDK.
// `createMcpHandler` owns the wire: it routes `2026-07-28` (per-request
// envelope) and the handshake revisions before it off the same factory,
// validates the envelope and the mirrored headers, and stamps `resultType`,
// `serverInfo` and the cache hints. What lives here is this server's surface —
// the tools, the prompt, the skill — and nothing about the protocol.
// See docs/mcp.md.

import {
  INVALID_PARAMS,
  McpServer,
  ProtocolError,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  fromJsonSchema,
  isLegacyRequest,
} from '@modelcontextprotocol/server';
import { ONBOARDING, promptMessages } from './prompts';
import { SKILLS_EXTENSION, findSkill, listResources, listSkills, readResource } from './skills';
import { TOOLS, callTool, isCallerError } from './tools';
import type { Env, User } from './db';

const SERVER_INFO = { name: 'workout-mcp', version: '0.1.0' };

/** Every result a client may cache, and for how long. See docs/mcp.md. */
const CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' } as const;

/**
 * Advertises a tool's JSON Schema in `tools/list` without rejecting on it.
 *
 * The SDK would validate arguments first and answer in schema prose —
 * "#/steps: Items did not match schema." — in place of what `src/tools.ts`
 * writes for the model: "steps[0]: unknown field target_zone; allowed:
 * goal_km, goal_meters, ...". The schema is the contract a caller reads; the
 * parser in `src/tools.ts` is what tells it what went wrong, and it refuses
 * everything the schema does. Validating twice would only cost the message.
 */
const advertiseOnly = (schema: Record<string, unknown>) => {
  const standard = fromJsonSchema(schema);
  return {
    ...standard,
    '~standard': { ...standard['~standard'], validate: (value: unknown) => ({ value }) },
  } as typeof standard;
};

/**
 * `cacheHints` covers only the revision's closed list of cacheable results, so
 * the two skills methods — which are an extension, not spec vocabulary — carry
 * their own. Era-gated, because the handshake revisions have no cache fields
 * and would carry these straight through to the wire.
 */
const skillsCacheHint = (era: 'legacy' | 'modern') => (era === 'modern' ? CACHE_HINT : {});

/** One server per request: it closes over the athlete the token resolved to. */
function buildServer(env: Env, user: User, origin: string, era: 'legacy' | 'modern'): McpServer {
  const server = new McpServer(SERVER_INFO, {
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { listChanged: false },
    },
    cacheHints: {
      'tools/list': CACHE_HINT,
      'prompts/list': CACHE_HINT,
      'resources/list': CACHE_HINT,
      'resources/read': CACHE_HINT,
      'server/discover': CACHE_HINT,
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
          // A tool that refused its input is a successful call carrying
          // `isError`, so the model reads the message and can retry.
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
      { mimeType: resource.mimeType, cacheHint: CACHE_HINT },
      async (uri: URL) => ({
        contents: [{ uri: uri.href, mimeType: 'text/markdown', text: readResource(uri.href) ?? '' }],
      }),
    );
  }

  // The Skills extension is not spec vocabulary and the SDK has no support for
  // it, so the two methods are registered as custom ones. `params` must be a
  // Standard Schema, hence `fromJsonSchema` over a schema written here.
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} } } as never);

  server.server.setRequestHandler(
    'skills/list',
    { params: fromJsonSchema({ type: 'object', additionalProperties: true }) },
    async () => ({ ...skillsCacheHint(era), skills: await listSkills() }),
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
      const uri = (params as { uri?: string })?.uri;
      const skill = await findSkill(uri);
      // A bare Error would surface as an internal error; a uri we do not serve
      // is the caller's, and reads as one.
      if (!skill) throw new ProtocolError(INVALID_PARAMS, `no skill at "${String(uri ?? '')}"`);
      return { ...skillsCacheHint(era), skill };
    },
  );

  return server;
}

/**
 * The handshake era, served here rather than by the SDK's own fallback.
 *
 * Left to itself the fallback answers this era over SSE, and holds a client to
 * the revision's `Accept: text/event-stream` with a 406. Both are conformant,
 * and both would break a client that has been talking to this server in plain
 * JSON without that header — which is the failure this server has already had
 * twice. `enableJsonResponse` keeps the bodies as they are, and going through
 * the transport directly means nothing is turned away for the header. This is
 * the composition the SDK documents for keeping your own legacy lane:
 * `isLegacyRequest` in front of a `legacy: 'reject'` handler.
 */
async function handleHandshakeEra(env: Env, user: User, origin: string, request: Request): Promise<Response> {
  // The transport asks for the revision's `Accept` whatever it is going to
  // answer with, so it is filled in when absent. With `enableJsonResponse` the
  // body is JSON either way, so a client that never sent the header is served
  // exactly what it was served before, rather than a 406.
  const accept = request.headers.get('Accept') ?? '';
  if (!accept.includes('text/event-stream')) {
    const headers = new Headers(request.headers);
    headers.set('Accept', 'application/json, text/event-stream');
    request = new Request(request, { headers });
  }

  const server = buildServer(env, user, origin, 'legacy');
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * One server per request, either era. The factory closes over the athlete, so
 * there is nothing to memoise and nothing that has to carry an identity between
 * calls — which is what keeps this inside the Workers free plan.
 */
export async function handleMcp(request: Request, env: Env, user: User): Promise<Response> {
  const origin = new URL(request.url).origin;

  if (await isLegacyRequest(request)) {
    return await handleHandshakeEra(env, user, origin, request);
  }

  const handler = createMcpHandler((ctx) => buildServer(env, user, origin, ctx.era), {
    // This lane serves the modern era only; the handshake era went to the
    // transport above.
    legacy: 'reject',
    // One JSON body per POST, never a stream. Nothing here emits a message
    // before its result, so `auto` would never upgrade anyway — saying so makes
    // it a rule rather than a coincidence, and means the handler can be closed
    // as soon as `fetch` resolves without cutting a response short.
    responseMode: 'json',
  });

  try {
    return await handler.fetch(request);
  } finally {
    await handler.close().catch(() => {});
  }
}
