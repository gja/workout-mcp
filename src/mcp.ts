// MCP over Streamable HTTP, in both eras. `createMcpHandler` owns the wire; what lives
// here is this server's surface — the tools, the prompt, the skill. See docs/mcp.md.

import {
  INTERNAL_ERROR,
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

/** The revision `server/discover` advertises. The handshake era negotiates its own. */
const MODERN_VERSION = '2026-07-28';

/**
 * Newest first; `initialize` counter-offers the first a client can take. Set here because
 * the SDK's own list reaches back to revisions nothing here has been written against.
 */
const HANDSHAKE_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];

/** Allocated to the protocol itself, and answered with a 400. */
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * All a caller is told about a fault that is ours: the message may hold a table name, a
 * query or a token. The id ties the answer to the log line.
 */
function report(where: string, error: unknown): string {
  const id = crypto.randomUUID();
  console.error(`mcp error ${id} (${where})`, error);
  return `internal error. Quote ${id} when reporting this.`;
}

/** Every result a client may cache, and for how long. See docs/mcp.md. */
const CACHE_HINT = { ttlMs: 300_000, cacheScope: 'public' } as const;

/**
 * Advertise-only: the SDK would validate first and answer in schema prose in place of
 * what `src/tools.ts` writes for the model. The parser there refuses everything the
 * schema does, so validating twice would only cost the message.
 */
const advertiseOnly = (schema: Record<string, unknown>) => {
  const standard = fromJsonSchema(schema);
  return {
    ...standard,
    '~standard': { ...standard['~standard'], validate: (value: unknown) => ({ value }) },
  } as typeof standard;
};

/**
 * `TOOLS` is compiled in and cannot change under us, so a schema is converted once per
 * isolate rather than per request — lazily, so an isolate that never serves MCP pays
 * nothing.
 */
const advertised = new Map<string, ReturnType<typeof advertiseOnly>>();
const schemaFor = (tool: (typeof TOOLS)[number]) => {
  let schema = advertised.get(tool.name);
  if (!schema) {
    schema = advertiseOnly(tool.inputSchema as Record<string, unknown>);
    advertised.set(tool.name, schema);
  }
  return schema;
};

/**
 * `cacheHints` covers only the revision's closed list, so the two skills methods carry
 * their own. Era-gated: the handshake revisions have no cache fields.
 */
const skillsCacheHint = (era: 'legacy' | 'modern') => (era === 'modern' ? CACHE_HINT : {});

/** One server per request: it closes over the athlete the token resolved to. */
function buildServer(env: Env, user: User, origin: string, era: 'legacy' | 'modern'): McpServer {
  const server = new McpServer(SERVER_INFO, {
    supportedProtocolVersions: HANDSHAKE_VERSIONS,
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

  // Nothing of ours should fail silently: the protocol layer reports out-of-band
  // faults and rejected requests here, and nowhere else.
  server.server.onerror = (error) => void report('server', error);

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        annotations: tool.annotations,
        inputSchema: schemaFor(tool),
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
          throw new ProtocolError(INTERNAL_ERROR, report(`tool ${tool.name}`, error));
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

  // Not spec vocabulary, so the two methods are registered as custom ones. `params` must
  // be a Standard Schema, hence `fromJsonSchema`.
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
 * The transport refuses on `Accept` (406) and `Content-Type` (415); these are filled in
 * rather than enforced, so a client that has been talking to us without them is not
 * dropped by a change of implementation. The answer is JSON either way.
 */
function withTransportPreconditions(request: Request): Request {
  const accept = request.headers.get('Accept') ?? '';
  const wantsBoth = accept.includes('application/json') && accept.includes('text/event-stream');
  const jsonBody = (request.headers.get('Content-Type') ?? '').includes('application/json');
  if (wantsBoth && jsonBody) return request;

  const headers = new Headers(request.headers);
  if (!wantsBoth) headers.set('Accept', 'application/json, text/event-stream');
  if (!jsonBody) headers.set('Content-Type', 'application/json');
  return new Request(request, { headers });
}

/**
 * Served here rather than by the SDK's own fallback, which answers this era over SSE and
 * holds a client to `Accept: text/event-stream` with a 406 — breaking a client that has
 * been talking to this server in plain JSON. The composition the SDK documents for a
 * legacy lane: `isLegacyRequest` in front of a `legacy: 'reject'` handler.
 */
async function handleHandshakeEra(env: Env, user: User, origin: string, request: Request): Promise<Response> {
  request = withTransportPreconditions(request);

  // An array request is answered with an array even when one member had an id. The
  // transport unwraps a single response, so remember this before the body is read.
  let wasBatch = false;
  try {
    wasBatch = Array.isArray(await request.clone().json());
  } catch {
    // Not JSON, or not readable twice: the transport will refuse it on its own.
  }

  const discover = await discoverProbe(request, env, user, origin);
  if (discover) return discover;

  const server = buildServer(env, user, origin, 'legacy');
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  transport.onerror = (error) => void report('handshake transport', error);

  try {
    await server.connect(transport);
    return await rebatch(await transport.handleRequest(request), wasBatch);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

/**
 * `server/discover` without a version header.
 *
 * A client probing for the modern era has nothing to put in that header yet, so
 * the probe is classified as the handshake era and the SDK answers `-32601` —
 * it binds an instance to one era at construction and discover is a
 * `2026-07-28` method. The dispatcher this replaces served discover in both
 * eras, and a `-32601` here sends the probe back to `initialize` and pins a
 * modern client to the handshake era for good. So it is answered directly,
 * shaped as the handshake era shapes a result: no `resultType`, no cache hints.
 */
async function discoverProbe(
  request: Request,
  env: Env,
  user: User,
  origin: string,
): Promise<Response | null> {
  let body: { method?: unknown; id?: unknown } | undefined;
  try {
    body = (await request.clone().json()) as { method?: unknown; id?: unknown };
  } catch {
    return null;
  }
  if (body?.method !== 'server/discover') return null;

  // A notification is accepted and answered with nothing at all, as it is on
  // every other method in both eras.
  if (body.id === undefined || body.id === null) return new Response(null, { status: 202 });

  const server = buildServer(env, user, origin, 'legacy');
  try {
    return Response.json({
      jsonrpc: '2.0',
      id: body.id as string | number,
      result: {
        supportedVersions: [MODERN_VERSION],
        capabilities: server.server.getCapabilities(),
      },
    });
  } finally {
    await server.close().catch(() => {});
  }
}

async function rebatch(response: Response, wasBatch: boolean): Promise<Response> {
  if (!wasBatch || response.status !== 200) return response;

  const body = await response.clone().text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return response;
  }
  if (Array.isArray(parsed)) return response;

  return new Response(JSON.stringify([parsed]), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** One server per request, either era: the factory closes over the athlete, so nothing is memoised. */
export async function handleMcp(request: Request, env: Env, user: User): Promise<Response> {
  const origin = new URL(request.url).origin;

  // Refused here, naming what is served: left to the transport it is a generic `-32000`
  // where the era table promises `-32022`. Absent is not unknown — `initialize` carries
  // no version header.
  const declared = request.headers.get('MCP-Protocol-Version');
  if (declared !== null && declared !== MODERN_VERSION && !HANDSHAKE_VERSIONS.includes(declared)) {
    return Response.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: UNSUPPORTED_PROTOCOL_VERSION,
          message: `unsupported protocol version "${declared}"`,
          data: { supported: [MODERN_VERSION, ...HANDSHAKE_VERSIONS], requested: declared },
        },
      },
      { status: 400 },
    );
  }

  if (await isLegacyRequest(request)) {
    return await handleHandshakeEra(env, user, origin, request);
  }

  const handler = createMcpHandler((ctx) => buildServer(env, user, origin, ctx.era), {
    // This lane serves the modern era only; the handshake era went to the
    // transport above.
    legacy: 'reject',
    onerror: (error: Error) => void report('modern handler', error),
    // `responseMode` stays `auto`, which here is one JSON body per POST: the transport
    // only upgrades to SSE when something is sent before the result. Pinning it to
    // `'json'` said the same and cost a warning per request.
  });

  try {
    return await statusFromCode(await handler.fetch(withTransportPreconditions(request)));
  } finally {
    await handler.close().catch(() => {});
  }
}

/**
 * What a JSON-RPC code means to HTTP, on the modern era. Only our own fault is
 * a 5xx — an internal fault answered with a 400 tells a client it sent
 * something bad, and every retry layer in between believes it.
 */
const STATUS: Record<number, number> = {
  [-32700]: 400,
  [-32600]: 400,
  [-32601]: 404,
  [-32602]: 400,
  [-32603]: 500,
  [-32020]: 400,
  [-32022]: 400,
};

/**
 * The SDK answers an error the handler raised in-band, with a 200. The status is part of
 * this server's contract — a 404 is how a client tells a live MCP endpoint from a URL
 * with nothing behind it — so a code that names a status gets it.
 */
async function statusFromCode(response: Response): Promise<Response> {
  if (response.status !== 200) return response;

  const body = await response.clone().text();
  let parsed: { error?: { code?: unknown } } | undefined;
  try {
    parsed = JSON.parse(body) as { error?: { code?: unknown } };
  } catch {
    return response;
  }

  const code = parsed?.error?.code;
  const status = typeof code === 'number' ? STATUS[code] : undefined;
  if (status === undefined) return response;

  return new Response(body, { status, statusText: response.statusText, headers: response.headers });
}
