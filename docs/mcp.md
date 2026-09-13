# Connecting an MCP client

The server speaks Streamable HTTP and is **stateless** — one JSON-RPC request
per POST, no sessions and no SSE, which is what keeps it inside the Workers
free plan. A client may batch requests into an array; notifications drop out of
the response, and an all-notification batch gets a bare 202.

## With OAuth

Which is what a client that can open a browser will do on its own: point it at
`https://<your-worker>/mcp` and it discovers the rest. The client registers
itself, sends you to a consent page, you sign in with Google or Apple and
approve, and it gets a token. Nothing to copy.

That half is
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
Cloudflare's OAuth 2.1 library for exactly this case. It wraps the Worker and
owns the parts nobody should hand-roll:

| Endpoint | Owned by | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | the library | RFC 9728 — names the authorization server |
| `/.well-known/oauth-authorization-server` | the library | RFC 8414 — endpoint metadata |
| `POST /oauth/register` | the library | RFC 7591 — dynamic client registration |
| `POST /oauth/token` | the library | Code exchange, refresh, revocation |
| `GET /oauth/authorize` | us | The consent page — only we know how to sign someone in |

The library validates the bearer token on `/mcp` before our code runs and hands
the handler the athlete's identity. Grants live in `OAUTH_KV`, which is why the
Worker needs that namespace. Connected apps are listed on the dashboard and can
be disconnected there, which invalidates the access and refresh tokens
together.

`resourceMetadata` is deliberately left unconfigured, so the provider derives
the resource and issuer from the incoming request. The same build works on
`localhost:8787` and on your domain with nothing to change.

On the consent page itself, a bad `client_id` or `redirect_uri` is reported
rather than redirected to — an unvalidated redirect target is exactly what an
attacker would want. Approving posts the same query string back for the
provider to re-validate, so the grant is built from parameters it has just
checked. The consent bundle is also served as the static `/authorize.html`,
where nothing has been validated; reached that way it refuses to follow a
`redirect_uri` at all.

## With a static token

For a client that only takes a header — mint one on the dashboard under
*API tokens*. These are not OAuth tokens, so the provider would normally reject
them; the Worker registers a `resolveExternalToken` callback that resolves a
`wk_` token to the same identity, and both kinds arrive at the MCP handler
identically:

```json
{
  "mcpServers": {
    "workouts": {
      "type": "http",
      "url": "https://<your-worker>/mcp",
      "headers": { "Authorization": "Bearer wk_..." }
    }
  }
}
```

## Tools

`list_workouts`, `get_workout`, `create_workout`, `update_workout`,
`delete_workout`, `complete_workout`, `export_workout_fit`,
`get_workout_library`, `list_recorded_workouts`.

Each is also reachable over REST at `POST /api/tools/<name>` with the same
arguments, so a non-MCP client gets identical behaviour. The schemas live in
`src/tools.ts` and are the contract an assistant reads before writing a
workout, which is why they carry worked examples rather than leaving them to
prose. For what the fields mean, see [workouts.md](workouts.md).

### Planned, and recorded

The first seven tools are the *plan*: what the athlete intends to do, held here
and pushed to their watch. `list_recorded_workouts` is the other direction —
what they actually did, read back off a connected platform — and it is the tool
to reach for when the job is analysing real training rather than writing a
session. It answers with a link to the files rather than the files, for the
reason the next section gives. See [recordings.md](recordings.md).

### The library is read-only here

`get_workout_library` returns the athlete's workout library — reference prose on
how they train, worth reading before writing them a session — along with a note
saying that the dashboard and `PUT /api/library` are the two ways to change it.
There is deliberately no write tool: it is the athlete's standing instruction to
an assistant, and an assistant that could edit it would be editing its own
brief. See [library.md](library.md).

### Only one tool result carries a URL

A workout is identified by its date and id, and `export_workout_fit` returns
the whole file base64-encoded along with the name to save it under —
`2026-09-12-8x400m.fit`. An assistant handed a download link tends to pass the
link on instead of calling the tool, and the link is normally no use to whoever
receives it: the bytes sit behind the caller's own credential. The dashboard's
own routes still return links, because a browser can follow them.

`list_recorded_workouts` is the exception, and it is the exception precisely
because its link is *not* credential-bound. It is signed rather than guarded, so
passing it on is the thing to do with it — and the alternative is not an option
anyway: a month of recordings is tens of megabytes of FIT, which is not
something to base64 into a tool result. That is the line. A tool returns a URL
when the URL works for whoever ends up holding it, and not otherwise.

### Annotations

`list_workouts`, `get_workout`, `get_workout_library`, `export_workout_fit`
and `list_recorded_workouts` carry `readOnlyHint`,
which is what lets a client group them apart from the writes and allow them
without asking each time. `update_workout` and `delete_workout` carry
`destructiveHint`. `complete_workout` is a write but not a destructive one — it
cannot lose the plan it is recorded against. The hints only shape how a client
presents a tool; the server checks everything regardless.

### Errors

A tool that fails because of bad input reports it as a *successful* call with
`isError`, so the model sees the message and can retry. Only protocol-level
problems become JSON-RPC errors.
