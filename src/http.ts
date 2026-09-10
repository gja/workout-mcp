/**
 * The JSON and CORS conventions every handler shares.
 *
 * Small enough to have lived in `app.ts`, and it did — until the Garmin routes
 * needed the same helpers, at which point importing them from `app.ts` would
 * have meant `app.ts` and the routes it delegates to importing each other.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, ...headers } });

export const error = (message: string, status: number): Response => json({ error: message }, status);
