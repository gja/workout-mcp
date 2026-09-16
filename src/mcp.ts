// MCP over Streamable HTTP, in both eras: `2026-07-28` carries the protocol version,
// the client's identity and its capabilities on every request; the handshake revisions
// before it negotiate once with `initialize`. See docs/mcp.md.

import { findPrompt, listPrompts, promptMessages } from './prompts';
import { SKILLS_EXTENSION, findSkill, listResources, listSkills, readResource } from './skills';
import { TOOLS, ToolError, callTool, isCallerError } from './tools';
import type { Env, User } from './db';

const MODERN_VERSION = '2026-07-28';

/** What `initialize` answers. The handshake revisions before it are served too. */
const LEGACY_VERSION = '2025-06-18';

/**
 * Handshake revisions we recognise. A client naming one of these is served the old
 * way; one naming something we have never heard of is told what we do serve, which
 * is the only answer it can act on.
 */
const KNOWN_LEGACY = new Set(['2025-03-26', LEGACY_VERSION, '2025-11-25']);

const SUPPORTED_VERSIONS = [MODERN_VERSION, LEGACY_VERSION];

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: { _meta?: Record<string, unknown>; [key: string]: unknown };
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Allocated to the protocol itself, and both answered with a 400. */
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** What a JSON-RPC code means to HTTP. Only our own fault is a 5xx. */
const STATUS: Record<number, number> = {
  [PARSE_ERROR]: 400,
  [INVALID_REQUEST]: 400,
  [METHOD_NOT_FOUND]: 404,
  [INVALID_PARAMS]: 400,
  [INTERNAL_ERROR]: 500,
  [HEADER_MISMATCH]: 400,
  [UNSUPPORTED_PROTOCOL_VERSION]: 400,
};

const SERVER_INFO = { name: 'workout-mcp', version: '0.1.0' };

const CAPABILITIES = {
  tools: { listChanged: false },
  prompts: { listChanged: false },
  resources: { listChanged: false },
  // An empty settings object is support without `resources/directory/read`, which
  // a manifest of one file has nothing to say that `resources/list` does not.
  extensions: { [SKILLS_EXTENSION]: {} },
};

/**
 * The results a client may cache, and for how long. Every one of them is the same
 * for every athlete — built from code, not from their data — so a shared cache may
 * hold one. Anything per-athlete here would have to be `private`.
 */
const CACHEABLE = new Set([
  'server/discover',
  'tools/list',
  'prompts/list',
  'resources/list',
  'resources/read',
  'skills/list',
  'skills/get',
]);
const CACHE_HINTS = { ttlMs: 300_000, cacheScope: 'public' } as const;

/** Which body field the `Mcp-Name` header mirrors, for the methods that carry one. */
const NAMED_BY: Record<string, 'name' | 'uri'> = {
  'tools/call': 'name',
  'prompts/get': 'name',
  'resources/read': 'uri',
};

class MethodNotFound extends Error {
  constructor(method: string) {
    super(`unknown method "${method}"`);
  }
}

async function handleRequest(
  request: JsonRpcRequest,
  env: Env,
  user: User,
  origin: string,
): Promise<unknown> {
  switch (request.method) {
    case 'server/discover':
      return { supportedVersions: SUPPORTED_VERSIONS, capabilities: CAPABILITIES };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'prompts/list':
      return { prompts: listPrompts() };

    case 'prompts/get': {
      const params = (request.params ?? {}) as { name?: string };
      const prompt = findPrompt(params.name);
      if (!prompt) throw new ToolError(`unknown prompt "${String(params.name ?? '')}"`);
      return promptMessages(prompt);
    }

    case 'resources/list':
      return { resources: listResources() };

    case 'resources/read': {
      const uri = (request.params ?? {}).uri;
      const text = readResource(uri);
      if (text === undefined) throw new ToolError(`no resource at "${String(uri ?? '')}"`);
      return { contents: [{ uri, mimeType: 'text/markdown', text }] };
    }

    case 'skills/list':
      return { skills: await listSkills() };

    case 'skills/get': {
      const uri = (request.params ?? {}).uri;
      const skill = await findSkill(uri);
      if (!skill) throw new ToolError(`no skill at "${String(uri ?? '')}"`);
      return { skill };
    }

    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: string; arguments?: unknown };
      if (!params.name) throw new ToolError('tools/call requires a tool name');
      const result = await callTool(params.name, params.arguments, env, user, origin);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }

    default:
      throw new MethodNotFound(request.method);
  }
}

// --- Validation --------------------------------------------------------------

/** `=?base64?…?=`, which is how a header carries a name the ASCII range cannot. */
function decodeHeader(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try {
    const bytes = Uint8Array.from(atob(value.slice(9, -2)), (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return value;
  }
}

/**
 * The headers mirror body fields so a gateway can route without parsing the body.
 * Checked rather than trusted: a proxy acting on the header while this Worker acts
 * on the body is exactly the split the rule exists to close.
 */
function headerMismatch(request: Request, declared: string, body: JsonRpcRequest): string | null {
  if (declared !== body.params?._meta?.[META_PROTOCOL_VERSION]) {
    return `MCP-Protocol-Version header "${declared}" does not match the body's ${META_PROTOCOL_VERSION}`;
  }

  const method = request.headers.get('Mcp-Method');
  if (method === null) return 'Mcp-Method is required';
  if (method !== body.method) return `Mcp-Method header "${method}" does not match the body's method`;

  const field = NAMED_BY[body.method];
  if (field === undefined) return null;

  const named = request.headers.get('Mcp-Name');
  if (named === null) return `Mcp-Name is required for ${body.method}`;
  const inBody = (body.params ?? {})[field];
  if (typeof inBody === 'string' && decodeHeader(named) !== inBody) {
    return `Mcp-Name header does not match the body's params.${field}`;
  }
  return null;
}

/** A JSON-RPC request object, rather than a notification, an array or a bare null. */
const isRequestObject = (body: unknown): body is JsonRpcRequest =>
  typeof body === 'object' && body !== null && !Array.isArray(body) && typeof (body as JsonRpcRequest).method === 'string';

// --- The legacy era ----------------------------------------------------------

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

async function dispatch(
  request: JsonRpcRequest,
  env: Env,
  user: User,
  origin: string,
): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const isNotification = request.id === undefined || request.id === null;

  try {
    // The handshake, which this era opens with and the modern one has no method for.
    const result =
      request.method === 'initialize'
        ? { protocolVersion: LEGACY_VERSION, capabilities: CAPABILITIES, serverInfo: SERVER_INFO }
        : await handleRequest(request, env, user, origin);
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return null;
    // A tool that refused its input is a successful call carrying `isError`.
    if (isCallerError(error) && request.method === 'tools/call') {
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: error.message }], isError: true },
      };
    }
    if (error instanceof MethodNotFound) {
      return { jsonrpc: '2.0', id, error: { code: METHOD_NOT_FOUND, message: error.message } };
    }
    if (isCallerError(error)) {
      return { jsonrpc: '2.0', id, error: { code: INVALID_PARAMS, message: error.message } };
    }
    console.error('mcp error', error);
    return { jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: 'internal error' } };
  }
}

async function handleLegacy(body: unknown, env: Env, user: User, origin: string): Promise<Response> {
  // Notifications drop out of a batched response, and an all-notification batch gets a 202.
  const batch = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  if (batch.some((request) => !isRequestObject(request))) {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'expected JSON-RPC requests' } },
      { status: 400 },
    );
  }

  const responses = (await Promise.all(batch.map((r) => dispatch(r, env, user, origin)))).filter(
    (r): r is JsonRpcResponse => r !== null,
  );

  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

// --- The modern era ----------------------------------------------------------

const fail = (id: string | number | null, code: number, message: string, data?: unknown) =>
  Response.json(
    { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status: STATUS[code] ?? 400 },
  );

/**
 * Every result, not only the cacheable ones: the revision requires a `resultType` on
 * all of them, and an absent one is read as `complete` *only* from a server speaking
 * an earlier revision — which this is not, so a client is right to refuse it.
 *
 * `serverInfo` rides along on each one too, which the spec asks for so a stateless
 * server identifies itself without anything having to remember a handshake.
 */
function complete(id: string | number | null, result: unknown, cacheable = false): Response {
  return Response.json({
    jsonrpc: '2.0',
    id,
    result: {
      resultType: 'complete',
      ...(cacheable ? CACHE_HINTS : {}),
      ...(result as object),
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    },
  });
}

async function handleModern(
  request: Request,
  declared: string,
  body: unknown,
  env: Env,
  user: User,
  origin: string,
): Promise<Response> {
  if (!isRequestObject(body)) {
    return fail(null, INVALID_REQUEST, 'expected a single JSON-RPC request object');
  }

  const id = body.id ?? null;

  const mismatch = headerMismatch(request, declared, body);
  if (mismatch) return fail(id, HEADER_MISMATCH, mismatch);

  // A notification is accepted and answered with nothing at all.
  if (body.id === undefined || body.id === null) {
    try {
      await handleRequest(body, env, user, origin);
    } catch (error) {
      if (!isCallerError(error) && !(error instanceof MethodNotFound)) console.error('mcp error', error);
    }
    return new Response(null, { status: 202 });
  }

  try {
    const result = await handleRequest(body, env, user, origin);
    return complete(id, result, CACHEABLE.has(body.method));
  } catch (error) {
    // A tool that refused its input is a successful call carrying `isError`, so the
    // model reads the message and can retry.
    if (isCallerError(error) && body.method === 'tools/call') {
      return complete(id, { content: [{ type: 'text', text: error.message }], isError: true });
    }
    if (error instanceof MethodNotFound) return fail(id, METHOD_NOT_FOUND, error.message);
    if (isCallerError(error)) return fail(id, INVALID_PARAMS, error.message);
    console.error('mcp error', error);
    return fail(id, INTERNAL_ERROR, 'internal error');
  }
}

// --- The door ----------------------------------------------------------------

/**
 * The era is read off `MCP-Protocol-Version`, and not off the body.
 *
 * That header is what tells anything in the path whether the mirrored headers below
 * are contractual — the spec says an intermediary routing on them SHOULD reject a
 * request whose version does not require header-body validation. Choosing the era
 * from the body instead would let a caller skip that validation by leaving one field
 * out, while still sending headers a proxy would act on. The header decides, so
 * there is nothing to leave out.
 *
 * `initialize` carries no version header — the handshake is where the version is
 * agreed — so a request without one is the old era by definition.
 */
export async function handleMcp(request: Request, env: Env, user: User): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail(null, PARSE_ERROR, 'parse error');
  }

  const origin = new URL(request.url).origin;
  const declared = request.headers.get('MCP-Protocol-Version');

  if (declared === MODERN_VERSION) {
    return await handleModern(request, declared, body, env, user, origin);
  }
  if (declared === null || KNOWN_LEGACY.has(declared)) {
    return await handleLegacy(body, env, user, origin);
  }

  // Neither era: name what we do serve, which is the only thing it can act on.
  const id = isRequestObject(body) ? (body.id ?? null) : null;
  return fail(id, UNSUPPORTED_PROTOCOL_VERSION, `unsupported protocol version "${declared}"`, {
    supported: SUPPORTED_VERSIONS,
    requested: declared,
  });
}
