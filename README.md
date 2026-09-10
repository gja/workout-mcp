# workout-mcp

Plan structured workouts over MCP or a plain REST API, then export them as
Garmin **FIT** workout files. Runs entirely on Cloudflare's free tier: a single
Worker, a D1 database, and a static dashboard.

- **MCP** at `POST /mcp` — an assistant can write your training week.
- **REST** at `/api/*` — for a Garmin Connect IQ app, Watchletic, or curl.
- **FIT** at `/export/2026-09-12-a1b2c3d4.fit` — drop it on a watch.
- **Dashboard** at `/` — see the plan, download files, manage tokens.
- **Sign-in** with Google or Apple. No passwords, and no email to send.
- **OAuth 2.1** via `@cloudflare/workers-oauth-provider`, so an MCP client can
  connect with a button rather than a pasted token.

Only a rolling window is kept: **7 days back, 14 days ahead**, capped at 50
workouts per user. Anything outside that is pruned on write and by a nightly
cron trigger.

## Quick start

```bash
npm install
npx wrangler d1 create workout-mcp          # paste the id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # paste that id in too
npm run db:remote                           # apply schema.sql
npm run deploy
```

Then configure at least one sign-in provider — see below — and open the
dashboard.

`npm run db:local` seeds a local D1 and `npm run dev` serves everything at
`http://localhost:8787`.

## Signing in

There are no passwords and no email to send: identity comes from Google or
Apple. Each provider appears on the sign-in page only when its variables are
set, so **Google alone is a complete setup** — Apple is optional, and needs a
paid developer account.

Both are ordinary OpenID Connect flows, handled by
[`arctic`](https://arcticjs.dev), which also builds the ES256 client-secret
JWT that Apple wants instead of a static secret.

### Google

In the Google Cloud console, create an OAuth 2.0 Client ID of type *Web
application* and add `https://<your-worker>/auth/google/callback` as an
authorized redirect URI (plus `http://localhost:8787/auth/google/callback` for
local work — Google allows loopback). Then:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

### Apple

Sign in with Apple needs an Apple Developer Program membership, which is paid.
You need a Services ID, a Team ID, and a private key (a `.p8` file) with its
Key ID. Apple will not redirect to `localhost`, so this one only works on your
real domain.

```bash
npx wrangler secret put APPLE_CLIENT_ID     # the Services ID, e.g. com.example.workouts
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY   # the .p8 contents, base64 or PEM
```

### Who may sign in

Anyone with a Google account can reach the button, so a public deployment
usually wants to name who may actually get in:

```bash
npx wrangler secret put ALLOWED_EMAILS      # "me@example.com,@myteam.com"
```

Unset means anyone may sign up.

Two things worth knowing. An account is keyed by *(provider, subject)*, so
signing in with Google and then with Apple makes two separate accounts, each
with its own workouts — Apple's private relay hands out a different address
anyway, so there is no reliable way to link them. And the in-flight sign-in
state lives in D1 rather than a cookie, because Apple posts its callback back
cross-site, where a `SameSite=Lax` cookie would not be sent; the state is a
single-use random value with a ten-minute life.

## Connecting an MCP client

The server speaks Streamable HTTP and is stateless — one JSON-RPC request per
POST, no sessions and no SSE, which is what keeps it inside the Workers free
plan.

**With OAuth**, which is what a client that can open a browser will do on its
own: point it at `https://<your-worker>/mcp` and it discovers the rest. The
client registers itself, sends you to a consent page, you sign in with Google
or Apple and approve, and it gets a token. Nothing to copy.

That half is [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
Cloudflare's OAuth 2.1 library for exactly this case. It wraps the Worker and
owns the parts nobody should hand-roll:

| Endpoint | Owned by | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | the library | RFC 9728 — names the authorization server |
| `/.well-known/oauth-authorization-server` | the library | RFC 8414 — endpoint metadata |
| `POST /oauth/register` | the library | RFC 7591 — dynamic client registration |
| `POST /oauth/token` | the library | Code exchange, refresh, revocation |
| `GET /oauth/authorize` | us | The consent page — only we know how to sign someone in |

The library validates the bearer token on `/mcp` before our code runs and
hands the handler the athlete's identity. Grants live in `OAUTH_KV`, which is
why the Worker needs that namespace. Connected apps are listed on the
dashboard and can be disconnected there, which invalidates the access and
refresh tokens together.

`resourceMetadata` is deliberately left unconfigured, so the provider derives
the resource and issuer from the incoming request. The same build works on
`localhost:8787` and on your domain with nothing to change.

**With a static token**, for a client that only takes a header — mint one on
the dashboard under *Tokens*. These are not OAuth tokens, so the provider
would normally reject them; the Worker registers a `resolveExternalToken`
callback that resolves a `wk_` token to the same identity, and both kinds
arrive at the MCP handler identically:

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

Tools: `list_workouts`, `get_workout`, `create_workout`, `update_workout`,
`delete_workout`, `export_workout_fit`. Each one is also reachable over REST at
`POST /api/tools/<name>` with the same arguments, so a non-MCP client gets the
identical behaviour.

## Writing a workout

A workout is a date, a name, a sport and a list of steps. A step either **does
something** — a duration plus an optional target — or **repeats** a group of
steps.

```json
{
  "date": "2026-09-12",
  "name": "8x400m",
  "sport": "running",
  "steps": [
    { "name": "Warmup", "goal_s": 600, "target_heart_rate": [146, 153] },
    {
      "repeat": 8,
      "steps": [
        { "name": "Fast",  "goal_meters": 400, "target_pace_km": ["4:00", "4:15"] },
        { "name": "Float", "goal_s": 90,       "target_pace_km": ["-", "6:30"] }
      ]
    },
    { "name": "Cooldown", "goal_s": 600 }
  ]
}
```

### Durations — at most one per step

| Field | Meaning |
| --- | --- |
| `goal_s` | Seconds, or `"mm:ss"` / `"hh:mm:ss"` |
| `goal_meters`, `goal_km`, `goal_miles`, `goal_yards` | Distance |
| `goal_calories` | Calories burned |
| `goal_reps` | Repetitions, for strength work |
| `until_hr_above`, `until_hr_below` | Run until heart rate crosses a threshold |
| `until_watts_above`, `until_watts_below` | Same, for power |

A step with **no** duration runs until the lap button is pressed — which is
what you usually want for a cooldown.

### Targets — at most one per step

| Field | Accepts |
| --- | --- |
| `target_pace_km`, `target_pace_miles` | `"mm:ss"` paces |
| `target_heart_rate` | bpm, or `"85%"` of max HR |
| `target_watts` | watts, or `"95%"` of FTP |
| `target_cadence` | rpm |
| `target_zone` | heart-rate zone 1-5 |
| `target_hr_zone`, `target_pace_zone`, `target_power_zone`, `target_cadence_zone` | an explicit zone |

### Ranges

Every target takes a range as `[floor, ceiling]`, and either end may be `"-"`
to leave it open. A single value sets both ends.

```jsonc
"target_heart_rate": [140, 155]     // between 140 and 155 bpm
"target_heart_rate": [140, "-"]     // above 140
"target_heart_rate": ["-", 155]     // below 155
```

Pace reads the same way — first entry is the floor on effort — but because a
*lower* pace number is *faster*, that comes out as:

```jsonc
"target_pace_km": ["6:30", "-"]     // faster than 6:30/km
"target_pace_km": ["-", "8:00"]     // slower than 8:00/km
"target_pace_km": ["4:00", "4:15"]  // a 4:00-4:15/km band
```

A two-sided pace band is unambiguous whichever way round you write it, so
`["4:15", "4:00"]` means the same thing.

### The rest

`intensity` is one of `warmup`, `active`, `interval`, `rest`, `recovery`,
`cooldown`. Leave it out and it is guessed from the step name, defaulting to
`interval` inside a repeat and `active` elsewhere.

Repeats may nest up to three deep, and a workout may hold 200 steps in total.
Anything the server cannot make sense of comes back as an error naming the
exact field, e.g. `steps[1].steps[0].target_pace_km[0]: "nope" is not a valid
duration`.

## HTTP API

Authenticate with `Authorization: Bearer <token>` or, from a browser, the
session cookie set at login.

| Route | Does |
| --- | --- |
| `GET /api/health` | Liveness, no auth |
| `GET /auth/providers` | Which sign-in providers are configured |
| `GET /auth/:provider/start` | Begin a Google or Apple sign-in |
| `GET`/`POST /auth/:provider/callback` | Finish it, sets the session cookie |
| `POST /api/auth/logout` | End the session |
| `GET /api/me` | Who you are |
| `GET /api/tokens` | List API tokens |
| `POST /api/tokens` | `{name}` — mint an API token, returned once |
| `DELETE /api/tokens/:prefix` | Revoke one |
| `GET /api/connections` | List OAuth grants (connected MCP clients) |
| `DELETE /api/connections/:id` | Disconnect one |
| `GET /api/workouts.json?from=&to=` | List within the retention window |
| `POST /api/workouts` | Create; returns the id and URLs |
| `GET /api/workouts/:date/:id.json` | Read one |
| `PUT /api/workouts/:date/:id.json` | Replace one; change `date` to move it |
| `DELETE /api/workouts/:date/:id.json` | Delete one |
| `GET /export/:date-:id.fit` | The FIT file |
| `POST /api/tools/:name` | Any MCP tool, over REST |

A date may hold several workouts; each gets its own short id.

`/export` also accepts `?token=wk_...` as a query parameter, because a watch or
a plain link cannot set an `Authorization` header. That does put the token in
URLs and server logs — prefer the header where you can, as the dashboard does.

CORS is open (`Access-Control-Allow-Origin: *`), which is safe here because
authentication is a bearer token rather than a cookie.

## How it is built

```
src/units.ts      parsing primitives: durations, paces, open-ended ranges
src/workout.ts    the loose-JSON -> strict-model normalizer, and its errors
src/fit.ts        FIT encoding, including flattening nested repeats
src/describe.ts   human-readable rendering, shared by MCP and the dashboard
src/db.ts         D1 queries and retention
src/identity.ts   signing in with Google or Apple
src/auth.ts       sessions, accounts and API tokens
src/tools.ts      the tool surface shared by MCP and REST
src/mcp.ts        JSON-RPC over Streamable HTTP
src/app.ts        the OAuth provider's defaultHandler: login, consent, REST, assets
src/index.ts      the provider itself, and the protected /mcp handler
```

`src/index.ts` constructs the `OAuthProvider`, which wraps everything: it
claims the OAuth endpoints and `/mcp`, and passes every other request to
`src/app.ts`.

Nothing is stored in the clear. Session ids and API tokens are SHA-256 hashes
in D1; OAuth grants and their tokens are the library's problem, in KV. The
dashboard only ever shows a token prefix, and the full value is returned
exactly once, when it is minted.

An ID token coming back from Google or Apple is not signature-checked, and
does not need to be: it arrives over TLS from the provider's own token
endpoint, in response to a request authenticated with our client secret, which
[OpenID Connect Core 3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
allows explicitly. The issuer, audience and expiry are checked anyway, since
they cost nothing and catch a misconfigured client.

Two things are worth knowing if you touch `fit.ts`:

1. The FIT SDK's encoder writes *parent* fields only — it does not resolve
   subfield names like `durationTime` or `customTargetSpeedLow`. So the encoder
   writes `durationValue` / `customTargetValueLow` / `customTargetValueHigh`
   directly and applies the profile's scaling itself (time ×1000, distance
   ×100, speed ×1000, heart rate +100, power +1000).
2. FIT stores steps as a flat list. A repeat is a step emitted *after* its
   children, whose duration value points back at the first child's message
   index. `flattenSteps` does that, recursively.

Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`, so the FIT
encoder and the D1 queries are exercised on the same runtime that serves
production traffic. FIT files are asserted by decoding them again with the
SDK's own decoder. Google and Apple are stood in for by an auxiliary Worker
that Miniflare routes all outbound traffic to, so the real `arctic` path runs
— Apple's signed client secret included — without touching the network.

```bash
npm test        # 133 tests
npm run typecheck
```

| Suite | Covers |
| --- | --- |
| `workout.test.ts` | Parsing loose JSON: every duration and target, range semantics, repeats, intensity inference, and the error messages |
| `fit.test.ts` | FIT encoding, decoded back with the SDK: scaling, offsets, zones, names, intensities, repeat flattening, a full session |
| `api.test.ts` | The REST API and `/api/tools`, FIT downloads, cross-athlete isolation, bad requests, retention |
| `auth.test.ts` | Google and Apple sign-in, state handling, ID-token checks, sessions, API tokens |
| `oauth.test.ts` | Discovery, registration, consent, the PKCE code exchange, refresh, connected apps |
| `mcp.test.ts` | The JSON-RPC protocol and every tool |

## Cost

Everything here fits the Cloudflare free plan: Workers (100k requests/day),
D1 (5 GB, 5M row reads/day), KV, static assets and cron triggers. Encoding a
30-step workout is well under the free plan's 10 ms CPU limit. Google sign-in
is free. The only things you pay for are the domain — Cloudflare Registrar
sells those at cost — and, if you want the Apple button, an Apple Developer
membership.

There is no auth vendor in the stack. Auth0, Clerk, WorkOS and Stytch all have
workable free tiers, and the MCP-focused ones will host the whole
authorization server — but each adds an account every self-hoster of this repo
would also have to create, on top of the Google client they need anyway. The
protocol work is Cloudflare's library and `arctic`, not ours.

## Licence

MIT — see [LICENSE](LICENSE).

This project depends on [`@garmin/fitsdk`](https://github.com/garmin/fit-javascript-sdk),
which Garmin ships under the **Flexible and Interoperable Data Transfer (FIT)
Protocol License**, not an OSI licence. Nothing from the SDK is vendored here —
it is an ordinary npm dependency — but if you redistribute a build, read
Garmin's terms first.
