/**
 * The JSON conventions every handler shares.
 *
 * Small enough to have lived in `app.ts`, and it did — until the Garmin routes
 * needed the same helpers, at which point importing them from `app.ts` would
 * have meant `app.ts` and the routes it delegates to importing each other.
 *
 * There is deliberately no CORS here. Everything this module serves is either
 * same-origin (the dashboard fetching `/api/*` off the host that served it) or
 * not a browser at all (a watch app or curl holding a bearer token, neither of
 * which is subject to the same-origin policy). The one surface that genuinely
 * has cross-origin browser callers is `/mcp`, and that belongs to
 * `@cloudflare/workers-oauth-provider`: it answers the preflight and rewrites
 * `Access-Control-Allow-Origin` on the way out, for `/mcp` and for the OAuth
 * metadata, token and registration endpoints alike. Sending our own headers
 * under it achieved nothing but the appearance of a policy.
 */

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers });

export const error = (message: string, status: number): Response => json({ error: message }, status);
