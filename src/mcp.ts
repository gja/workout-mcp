// MCP over Streamable HTTP, stateless: one JSON-RPC request per POST. See docs/mcp.md.

import { TOOLS, ToolError, callTool, isCallerError } from './tools';
import type { Env, User } from './db';

const PROTOCOL_VERSION = '2025-06-18';

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: unknown };

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

const INVALID_PARAMS = -32602;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

const SERVER_INFO = { name: 'workout-mcp', version: '0.1.0' };

async function handleRequest(request: JsonRpcRequest, env: Env, user: User): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };

    case 'ping':
      return {};

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const params = (request.params ?? {}) as { name?: string; arguments?: unknown };
      if (!params.name) throw new ToolError('tools/call requires a tool name');
      const result = await callTool(params.name, params.arguments, env, user);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }

    default:
      throw new MethodNotFound(request.method);
  }
}

class MethodNotFound extends Error {
  constructor(method: string) {
    super(`unknown method "${method}"`);
  }
}

/** A successful call carrying `isError`, so the model reads the message and can retry. */
function toToolErrorResult(error: Error) {
  return { content: [{ type: 'text', text: error.message }], isError: true };
}

async function dispatch(request: JsonRpcRequest, env: Env, user: User): Promise<JsonRpcResponse | null> {
  const id = request.id ?? null;
  const isNotification = request.id === undefined || request.id === null;

  try {
    const result = await handleRequest(request, env, user);
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (error) {
    if (isNotification) return null;
    if (isCallerError(error) && request.method === 'tools/call') {
      return { jsonrpc: '2.0', id, result: toToolErrorResult(error) };
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

export async function handleMcp(request: Request, env: Env, user: User): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } },
      { status: 400 },
    );
  }

  // Notifications drop out of a batched response, and an all-notification batch gets a 202.
  const batch = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  const responses = (await Promise.all(batch.map((r) => dispatch(r, env, user)))).filter(
    (r): r is JsonRpcResponse => r !== null,
  );

  if (responses.length === 0) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}
