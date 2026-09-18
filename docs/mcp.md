# Connecting an MCP client

The server speaks Streamable HTTP at revision **`2026-07-28`** and the handshake
revisions before it. It is stateless — one JSON-RPC request per POST, no sessions, no SSE
— which is what the modern revision assumes and what keeps this inside the free plan. A
notification gets a bare 202.

The wire is the official SDK's: `createMcpHandler` from
[`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol) routes both eras
off one factory, validates the envelope and mirrored headers, and stamps `resultType`,
`serverInfo` and the cache hints. `src/mcp.ts` is this server's surface and the two places
that surface does not fit. It was hand-rolled until three conformance bugs had been found by
clients rather than by tests. Cloudflare's `agents` package wraps the same function and is
not used: 192 further packages and a `nodejs_compat` flag for things this server does not
need.

## With OAuth

Point a browser-capable client at `https://<your-worker>/mcp` and it discovers the rest.
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider)
owns everything except the consent page:

| Endpoint | Owned by | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | the library | RFC 9728 |
| `/.well-known/oauth-authorization-server` | the library | RFC 8414 |
| `POST /oauth/register` | the library | RFC 7591 dynamic client registration |
| `POST /oauth/token` | the library | Code exchange, refresh, revocation |
| `GET /oauth/authorize` | us | The consent page |

The library validates the bearer token on `/mcp` before our code runs. Grants live in
`OAUTH_KV`. `resourceMetadata` is deliberately unconfigured, so the provider derives the
resource and issuer from the request and the same build works on localhost and on your
domain.

On the consent page a bad `client_id` or `redirect_uri` is reported rather than redirected
to, and approving posts the same query string back for the provider to re-validate. The
same bundle is also served as static `/authorize.html`, where nothing has been validated;
reached that way it refuses to follow a `redirect_uri` at all.

## With a static token

Mint one on the dashboard under *API tokens*. These are not OAuth tokens, so the Worker
registers a `resolveExternalToken` callback that resolves a `wk_` token to the same
identity, and both kinds arrive at the handler identically:

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

`list_workouts`, `get_workout`, `create_workout`, `update_workout`, `reschedule_workout`,
`delete_workout`, `complete_workout`, `comment_workout`, `export_workout_fit`, `get_workout_stats`,
`get_workout_library`, `get_current_plan`, `get_scheduling_instructions`,
`get_workout_zones`, `get_onboarding_instructions`, `update_context`,
`list_recorded_workouts`.

A workout is named by its `id` alone: where a tool takes a `date` beside one it is
optional and ignored, kept because callers hold it. `get_workout` is the exception — a
date with no id reads the day, and answers with the workouts on it when there is more
than one.

Each is also `POST /api/tools/<name>` with the same arguments. The schemas live in
`src/tools.ts` and are the contract an assistant reads before writing a workout, which is
why they carry worked examples. For what the fields mean, see [workouts.md](workouts.md).

**Descriptions are kept to about 50 words each**, because this list is sent in full on
every `tools/list` — context paid for before anything is called. What earns a sentence is
what a caller cannot get from the name and the schema: a non-obvious order of calls, a
unit or sentinel that would be misread, a limit that will be hit, a constraint that
protects the athlete.

`get_workout_stats` is the cheap way to read real training ([stats.md](stats.md));
`list_recorded_workouts` is the drill-down, and the only way to reach a session never
planned here ([recordings.md](recordings.md)). The four context readers and
`update_context` are described in [context.md](context.md).

**A tool returns a URL only when the URL works for whoever ends up holding it.**
`export_workout_fit` returns the file base64-encoded with the name to save it under, because
an assistant handed a download link passes the link on and the bytes sit behind the caller's
own credential. `list_recorded_workouts` is the one exception, precisely because its link is
signed rather than guarded — and a month of recordings is not something to base64 into a
tool result.

**Annotations.** `readOnlyHint` on the ten readers, so a client can allow them without
asking each time; `destructiveHint` on `update_workout`, `delete_workout` and
`update_context`, the last because it replaces a document the athlete wrote in full.
`complete_workout`, `comment_workout` and `reschedule_workout` are writes but cannot lose the
plan. The hints only
shape presentation; the server checks everything regardless.

## Prompts

`prompts/list` and `prompts/get`, advertised in `initialize`. There is one,
`getting-started`, offered as something the athlete picks. Only name, title and description
go out in the list, so the body can be long where a tool description cannot. See
[prompts.md](prompts.md).

## Two eras, decided by one header

Revision `2026-07-28` removed the handshake: protocol version, identity and capabilities
became per-request `_meta`, mirrored into HTTP headers. **The era is read off
`MCP-Protocol-Version`, and never off the body:**

| `MCP-Protocol-Version` | Era | What happens |
| --- | --- | --- |
| `2026-07-28` | modern | every mirrored header checked, then the method |
| a handshake revision, or absent | legacy | `initialize` and what it negotiates |
| anything else | — | `400` and `-32022`, naming what is served |

Absent means legacy because `initialize` carries no version header. The handshake revisions
are `2025-11-25`, `2025-06-18` and `2025-03-26` — set here rather than left to the SDK,
whose own list reaches back to `2024-11-05` — and `initialize` is answered **at the revision
the client asked for**, or the newest we speak.

Routing on the header is not cosmetic. Choosing off `_meta`, as the first attempt did, lets
a caller send the mirrored headers a gateway routes on with a body doing something else and,
by omitting `_meta`, land in the legacy path where no header is ever compared. Validation
that can be skipped by leaving a field out is not validation.

Both eras are served because this has been modern-only twice, and each time a real client
turned out to be on the older revision with no fall-forward and no error it could retry from.

### What every request has to satisfy

| Header | Mirrors | Required on |
| --- | --- | --- |
| `MCP-Protocol-Version` | `_meta` protocol version | every request |
| `Mcp-Method` | `method` | every request |
| `Mcp-Name` | `params.name`, or `params.uri` | `tools/call`, `prompts/get`, `resources/read` |

The `_meta` envelope those mirror is three fields, all required on every modern request:
`io.modelcontextprotocol/protocolVersion`, `/clientInfo` and `/clientCapabilities`. A
version-only envelope is `400` with `-32602` naming what is missing; a missing or mismatched
header is `400` with `-32020`. A name outside ASCII arrives as `=?base64?…?=` and is decoded
before comparison. A modern body is a single request object — an array, a `null` or an
object with no `method` is `400` with `-32600`; batching stays a handshake-era affordance.
An unknown method is **`404`** with `-32601`, and the status is part of the contract: it is
how a client tells a live MCP endpoint from a URL with nothing behind it.

`server/discover` replaces `initialize` and every modern server MUST implement it. It is
answered **without** a version header too, where the table above would send it to the
handshake era: a client probing for the modern era has nothing to put in that header yet,
and the SDK binds an instance to one era at construction — so left alone the probe gets
`-32601`, falls back to `initialize`, and pins a modern client to the handshake era for
good. `ping` was removed by the revision (SEP-2577), so it is `404`/`-32601` on
`2026-07-28` and still answered on the handshake era.

The handshake era is served through the transport directly rather than the SDK's own
fallback, which would answer over SSE and hold a client to `Accept: text/event-stream` with
a `406` — dropping a client that has been talking to this server in plain JSON. So
`enableJsonResponse` keeps the bodies as they were and the header is filled in when absent
rather than enforced.

`resultType` and `io.modelcontextprotocol/serverInfo` go on **every** modern result, not
only the cacheable ones — an absent `resultType` is read as `complete` only from a server
speaking an earlier revision. Neither goes on a handshake-era result.

### Which failures are whose

The JSON-RPC code decides the HTTP status, and only our own fault is a `5xx`:
`-32020`/`-32022`/`-32600`/`-32602`/`-32700` are `400`, `-32601` is `404`, `-32603` is
`500`. That last row matters — an internal fault answered with a `400` tells every retry
layer in between that a transient database failure is a permanent client error. The
handshake era answers a JSON-RPC error with a `200`, as it always has.

A tool that *refuses its input* is none of these: it stays a `200` carrying `isError`, so
the model reads the message and can try again. A tool *name* not in `tools/list` is
`-32602`, because it never reached a tool.

A tool that *breaks* is the one case the SDK will not let out as an error — it turns every
throw from a tool into an `isError` result, which is what the spec asks, and is **the one
place the code-to-status table does not reach**. What comes back carries no detail at all,
because a fault message may hold a table name, a query or a token:

```
internal error. Quote 9f230b3c-bf3e-4a4b-8965-1cdc20bffed6 when reporting this.
```

The same id is logged beside the real error; everything else reports through `onerror`.

Refusal messages are written in `src/tools.ts` and are what the model acts on. The SDK
would validate against the advertised JSON Schema first and answer in schema prose instead,
so the schema is registered as advertise-only: still what `tools/list` publishes, while the
parser in `src/tools.ts` says what went wrong.

### Cacheable results

`server/discover`, `tools/list` and `prompts/list` carry `resultType`, `ttlMs` and
`cacheScope`, all `public` — each is built from code rather than from the athlete's data.
**Anything per-athlete would have to be `private`**, since a public cache may serve it
across authorization contexts. This is why the onboarding interview lives behind a tool
rather than a discover-time field.

## Skills

The [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview) is
declared as `io.modelcontextprotocol/skills` and serves one skill: the onboarding
interview, the same body the prompt and `get_onboarding_instructions` serve. `skills/list`
and `skills/get` hand over the entry; the bytes come back through `resources/read`, which
is why `resources` is declared alongside. A skill is the one primitive the spec lets
*either* the model or the user choose, and the only one whose body is not paid for until it
is wanted.

The name is qualified — `workouts-mcp-onboarding-wizard` against the prompt's
`getting-started` — because a skill's name travels into a space holding every skill a host
knows, and it must match the last segment of its URI's parent directory.

**One file, deliberately**: deferring a file that is always needed buys nothing, and every
run of the interview ends by writing all three documents.

A host verifies each file's URI, digest and byte size, plus the frontmatter field by field,
before loading anything. So the digests are taken of exactly the bytes `resources/read`
returns, and the frontmatter is **double-quoted YAML** — a colon or a `#` in a plain scalar
would parse as something else and fail the comparison. The bytes are compiled into the
Worker, so the manifest is hashed once per isolate.

## What is not built

SSE response streams, `subscriptions/listen`, and multi round-trip requests: every tool
here answers in one shot. `resources/directory/read` is not implemented either, and the
extension is declared with the empty settings object that says so.

The `Origin` check the transport calls for is not implemented. It guards against DNS
rebinding, which works by borrowing a browser's ambient credentials, and `/mcp` has none to
borrow — it is bearer-token guarded and sets no cookie. Worth revisiting if that changes.
