# Connecting an MCP client

The server speaks Streamable HTTP at revision **`2026-07-28`**, and the handshake
revisions before it. It is stateless — one JSON-RPC request per POST, no sessions,
no SSE — which is both what the modern revision assumes and what keeps this inside
the Workers free plan. A notification gets a bare 202.

The wire itself is the official SDK's. `createMcpHandler` from
[`@modelcontextprotocol/server`](https://github.com/modelcontextprotocol) routes
both eras off one factory, validates the envelope and the mirrored headers, and
stamps `resultType`, `serverInfo` and the cache hints; `src/mcp.ts` is this
server's surface and the two places that surface does not fit. It was hand-rolled
until three conformance bugs had been found by clients rather than by tests, the
last of them by reading the SDK. Cloudflare's `agents` package wraps the same
function, and is not used: it costs 192 further packages and a `nodejs_compat`
flag to add route matching, CORS and an `AsyncLocalStorage` this server does not
need, since `OAuthProvider` already hands the athlete's identity to the handler.

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
`delete_workout`, `complete_workout`, `comment_workout`, `export_workout_fit`,
`get_workout_stats`, `get_workout_library`, `get_current_plan`,
`get_scheduling_instructions`, `get_workout_zones`, `get_onboarding_instructions`,
`update_context`, `list_recorded_workouts`.

Each is also reachable over REST at `POST /api/tools/<name>` with the same
arguments, so a non-MCP client gets identical behaviour. The schemas live in
`src/tools.ts` and are the contract an assistant reads before writing a
workout, which is why they carry worked examples rather than leaving them to
prose. For what the fields mean, see [workouts.md](workouts.md).

**The descriptions are kept to about 50 words each**, because this list is sent
in full on every `tools/list` — context paid for before anything is called. What
earns a sentence is what a caller cannot get from the name and the schema: an
order of calls that is not obvious (read the context documents before writing a
session), a unit or sentinel that would be misread (pace is seconds per
kilometre; a missing figure is null, never 0), a limit that will be hit, and a
constraint that protects the athlete. The worked examples stay, in the step
schema, where they are the thing being explained.

### Planned, and recorded

The first eight tools are the *plan* and what came back from it: what the
athlete intends to do, held here and pushed to their watch, plus the two verbs
that record what actually happened. Two more go the other way, and they are the ones to reach
for when the job is analysing real training rather than writing a session.

`get_workout_stats` is the cheap one, and the place to start: the session the
athlete recorded against a planned workout, already reduced to totals, laps,
quarters and how much of each lap sat inside its target — read off the FIT file
once when the platform said it was ready, and answering planned-versus-actual
without downloading anything. See [stats.md](stats.md).

`list_recorded_workouts` is the drill-down, and the only way to reach a session
that was never planned here. It hands over the recordings themselves, as a link
to the files rather than the files, for the reason the next section gives. See
[recordings.md](recordings.md).

### Four tools to read the context, one to write it

`get_workout_library`, `get_current_plan`, `get_scheduling_instructions` and
`get_workout_zones` each return one markdown document describing how this
athlete trains. A tool per document rather than one tool with a `kind`
argument, because the tool list is what a client reads before it decides to call
anything: an enum value is only discoverable to something that has already
decided to look inside. Each says what belongs in its own document, what comes
back, and how to change it — and nothing about its siblings, which the tool list
already shows. `create_workout` and `update_workout` are the ones that name all
four, because that is where reading them actually has to happen.

`update_context` is a single tool going the other way, and deliberately separate
from the readers: a client can be allowed to read the context freely and still
ask every time something wants to rewrite it. It covers three of the four
documents; the workout library is read-only here and is edited on the dashboard,
because it is the athlete's standing brief and an assistant that could edit it
would be editing its own. See [context.md](context.md).

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

`list_workouts`, `get_workout`, `get_workout_stats`, the four context readers,
`get_onboarding_instructions`, `export_workout_fit` and `list_recorded_workouts`
carry `readOnlyHint`,
which is what lets a client group them apart from the writes and allow them
without asking each time. `update_workout`, `delete_workout` and
`update_context` carry `destructiveHint` — the last of those because it
replaces a document the athlete wrote, in full. `complete_workout` is a write but not a destructive one — it
cannot lose the plan it is recorded against, and nor can `comment_workout`. The
hints only shape how a client presents a tool; the server checks everything regardless.

### Errors

A tool that fails because of bad input reports it as a *successful* call with
`isError`, so the model sees the message and can retry. Only protocol-level
problems become JSON-RPC errors.

## Prompts

`prompts/list` and `prompts/get`, advertised in `initialize` alongside the
tools. There is one — `getting-started`, the interview that fills an athlete's
context documents from their answers — and a client offers it as something the
athlete picks rather than something the model calls. Only the name, title and
description go out in the list; the body is sent once it is asked for, which is
why it can be long where a tool description cannot.

The model never sees a prompt, so the same interview also sits behind
`get_onboarding_instructions`, and every empty context read carries a
`next_step` naming it. See [prompts.md](prompts.md).

## Two eras, decided by one header

Revision `2026-07-28` removed the handshake: protocol version, identity and
capabilities became per-request `_meta`, mirrored into HTTP headers. The
revisions before it negotiate once, with `initialize`. Both are answered here, on
the same endpoint.

**The era is read off `MCP-Protocol-Version`, and never off the body:**

| `MCP-Protocol-Version` | Era | What happens |
| --- | --- | --- |
| `2026-07-28` | modern | every mirrored header checked, then the method |
| a handshake revision, or absent | legacy | `initialize` and what it negotiates |
| anything else | — | `400` and `-32022`, naming what is served |

Absent means legacy because `initialize` carries no version header: the handshake
is where the version is agreed, so there is nothing to put in one yet. The SDK
classifies each request the same way, and `initialize` is answered **at the
revision the client asked for** — `2025-03-26`, `2025-06-18` and `2025-11-25` each
come back as themselves, and one nobody here knows comes back as the newest we do
speak. This server used to answer every handshake client `2025-06-18` whatever it
had asked for.

That header is also what tells anything in the path whether the mirrored headers
are contractual — the transport spec says an intermediary routing on them SHOULD
reject a request whose version does not require header-body validation. So it is
the right thing to route on, and it is the only thing that cannot be left out.

### Why the body is the wrong thing to route on

The first attempt at two eras chose from the body's `_meta`, and it was wrong in
a way worth recording. A caller could send the mirrored headers a gateway would
route on — `Mcp-Method: tools/list` — with a body doing something else entirely,
and by omitting `_meta` land in the legacy path, where no header is ever
compared. Validation that can be skipped by leaving a field out is not
validation. Routing on the header closes that, because the header is what
decides: a request claiming the modern era is checked whatever its body says.

### Both, because both exist

This has been modern-only twice, and each time a real client turned out to be on
the older revision — first the assistant clients, which have since moved, then a
connector reaching the server through different plumbing. The protocol was right
and the server was unreachable, which is worse.

A handshake client cannot work that out for itself: it has no fall-forward, no
error it can read and retry from. Serving both costs one extra path and removes
that whole failure mode, so both are served until nothing on the older revision
is left.

### What every request has to satisfy

`server/discover` replaces `initialize` and every modern server **MUST**
implement it. It returns the version served, the capabilities, and `serverInfo`
under `_meta` — no handshake, nothing remembered. `supportedVersions` names the
modern revisions only: the handshake era is reached through `initialize`, not
advertised here.

`ping` is not among them. The revision removed it (SEP-2577), so it is `404`
with `-32601` on `2026-07-28` and still answered on the handshake era.

The headers mirror body fields so a gateway can route without parsing the body,
and the server checks them rather than trusting either alone. A proxy acting on
the header while this Worker acts on the body is exactly the split the rule
exists to close.

| Header | Mirrors | Required on |
| --- | --- | --- |
| `MCP-Protocol-Version` | `_meta` protocol version | every request |
| `Mcp-Method` | `method` | every request |
| `Mcp-Name` | `params.name`, or `params.uri` | `tools/call`, `prompts/get`, `resources/read` |

The `_meta` envelope those headers mirror is three fields, not one:
`io.modelcontextprotocol/protocolVersion`,
`io.modelcontextprotocol/clientInfo` and
`io.modelcontextprotocol/clientCapabilities`. All three are required on every
modern request, and one carrying only the version is `400` with `-32602` naming
what is missing. This server took a version-only envelope for as long as it was
hand-rolled — no conformant client would have sent one, so nothing broke, but
nothing would have caught it either.

These apply to a request that claims `2026-07-28`; the handshake era defines none
of them. A missing or mismatched header is `400` with `-32020`
(`HeaderMismatch`). A name outside the ASCII range arrives as `=?base64?…?=` and
is decoded before being compared. An unknown method is **`404`** with `-32601` —
the status is part of the contract, because it is how a client tells a live MCP
endpoint from a URL with nothing behind it.

A modern body is a single request object; an array, a `null` or an object with no
`method` is `400` with `-32600`, rather than whatever a cast to the request type
would have done with it. Batching stays a handshake-era affordance, where
notifications drop out of the response and an all-notification batch gets a bare
202.

The handshake era is served through the transport directly rather than through
the SDK's own fallback for it, which is the composition the SDK documents for
keeping your own legacy lane. Left to itself that fallback answers the old era
over SSE and holds a client to the revision's `Accept: text/event-stream` with a
`406`. Both are conformant and both would drop a client that has been talking to
this server in plain JSON without that header — the failure this server has
already had twice. So `enableJsonResponse` keeps the bodies as they were and the
header is filled in when absent rather than enforced.

### Every result says what it is

`resultType` goes on **every** modern result, not only the cacheable ones — the
revision requires it, and an absent one is read as `complete` *only* from a server speaking
an earlier revision. This got it wrong once: the caching rules say which results
carry `ttlMs` and `cacheScope`, and were misread as saying which carry
`resultType` at all. A conforming client refused every `tools/call` until it was
fixed, correctly.

`io.modelcontextprotocol/serverInfo` rides on every modern result too, which the
spec asks for so a stateless server identifies itself without anything having to
remember a handshake. Neither field goes on a handshake-era result: both are
`2026-07-28` concepts, and a client of the older revision would not know them.

### Which failures are whose

The JSON-RPC code decides the HTTP status, and only our own fault is a `5xx`:

| Code | Status | Meaning |
| --- | --- | --- |
| `-32020`, `-32022`, `-32600`, `-32602`, `-32700` | `400` | the request was wrong |
| `-32601` | `404` | no such method here |
| `-32603` | `500` | we broke |

That last row is the one worth keeping honest. An internal fault answered with
a `400` tells a client it sent something bad, and every retry layer in between
believes it — so a transient database failure would read as a permanent client
error and never be retried.

A tool that *refuses its input* is none of these. It stays a `200` carrying
`isError`, so the model reads the message and can try again; only protocol-level
problems become JSON-RPC errors. A tool *name* that is not in `tools/list` is one
of those: it never reached a tool, so it is `-32602` rather than a refused call.

Those refusal messages are written in `src/tools.ts` and are what the model acts
on — "steps[0]: unknown field target_zone; allowed: goal_km, goal_meters, …". The
SDK would validate arguments against the advertised JSON Schema first and answer
in schema prose instead, so the schema is registered as advertise-only: it is
still what `tools/list` publishes, and the parser in `src/tools.ts` — which
refuses everything the schema does — is still what says what went wrong.

### Cacheable results

`server/discover`, `tools/list` and `prompts/list` carry `resultType`, `ttlMs`
and `cacheScope`, which the spec requires of them. All three go out
`cacheScope: "public"`, and that is a claim worth checking rather than copying:
each is built from code rather than from the athlete's data, so one athlete's
copy really is every athlete's. **Anything per-athlete in one of these would
have to be `private`** — a public cache is allowed to serve it across
authorization contexts, from an authenticated endpoint. This is why the
onboarding interview lives behind a tool rather than in a discover-time field;
see [prompts.md](prompts.md).

## Skills

The [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
is declared as `io.modelcontextprotocol/skills` and serves one skill: the
onboarding interview, the same body the prompt and `get_onboarding_instructions`
serve. `skills/list` and `skills/get` hand over the entry; the bytes come back
through `resources/read`, which is why the `resources` capability is declared
alongside.

**Why a skill, when the interview already had three doors.** A prompt reaches
only the athlete and a tool only the model; a skill is the one primitive the
spec lets *either* choose — "selected by the model based on their names and
descriptions, or explicitly by the user". It is also the only one where the body
is not paid for until it is wanted: `skills/list` carries the frontmatter and a
file manifest, and a host **MUST NOT** fetch the files ahead of need.

### The name is qualified where the prompt's is not

`workouts-mcp-onboarding-wizard`, against the prompt's `getting-started`. A
prompt is listed under the server that serves it, so its name is read in that
company. A skill's name travels with it into a space holding every skill a host
knows, where "getting-started" says nothing about what it starts. The skill's
`name` must also match the last segment of its URI's parent directory, which is
what makes `skill://workouts-mcp-onboarding-wizard/SKILL.md` the URI.

### One file, deliberately

A skill may be a directory, and splitting the interview — the rounds in
`SKILL.md`, the per-document detail under `references/` — is the obvious use of
the manifest. It is not done, because **deferring a file that is always needed
buys nothing**: every run of this interview ends by writing all three documents,
so the reference would be fetched every time, one round-trip later than if it
had been there.

### What a host checks, and therefore what we serve

The entry's manifest gives each file's URI, SHA-256 digest and byte size, and a
host verifies all three — plus the frontmatter, field by field — before loading
anything. So the digests are taken of exactly the bytes `resources/read` returns,
frontmatter included, and the frontmatter is written as **double-quoted YAML**: a
description is prose, and a colon or a `#` in a plain scalar would parse as
something else and fail the comparison.

The bytes are compiled into the Worker and cannot change under us, so the
manifest is hashed once per isolate rather than per request.

## What is not built

SSE response streams, `subscriptions/listen`, and multi round-trip requests.
Every tool here answers in one shot, so a stream would be an empty pipe.
`resources/directory/read` is not implemented either, and the extension is
declared with the empty settings object that says so — a manifest of one file
has nothing to tell a directory walk that `resources/list` does not.

The `Origin` check the transport calls for is also not implemented. It guards
against DNS rebinding, which works by borrowing a browser's ambient credentials;
`/mcp` has none to borrow, since it is bearer-token guarded and sets no cookie.
Worth revisiting if that ever stops being true.
