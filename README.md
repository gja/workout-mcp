# workout-mcp

Plan structured workouts over MCP or a plain REST API, then export them as
Garmin **FIT** workout files. Runs entirely on Cloudflare's free tier: a single
Worker, a D1 database, and a static dashboard.

- **MCP** at `POST /mcp` — an assistant can write your training week.
- **REST** at `/api/*` — for a Garmin Connect IQ app, Watchletic, or curl.
- **FIT** at `/export/2026-09-12-a1b2c3d4.fit` — drop it on a watch.
- **Dashboard** at `/` — see the plan, download files, manage tokens.
- **Sign-in** by email and a six-digit code. No passwords.
- **OAuth 2.1** so an MCP client can connect with a button rather than a
  pasted token.

Only a rolling window is kept: **7 days back, 14 days ahead**, capped at 50
workouts per user. Anything outside that is pruned on write and by a nightly
cron trigger.

## Quick start

```bash
npm install
npx wrangler d1 create workout-mcp        # paste the id into wrangler.jsonc
npm run db:remote                         # apply schema.sql
npm run deploy
```

Then open the dashboard, enter your email, and type in the code. The first
verified login creates the account.

For that email to arrive you need one more thing — see **Sending the login
code** below. Locally you do not: `npm run db:local` seeds a local D1, and
`npm run dev` serves everything at `http://localhost:8787` with the login code
printed to the terminal instead of emailed.

## Sending the login code

Cloudflare has no outbound transactional email. Email Routing is inbound only,
and an Email Worker may only send to addresses already verified on your own
account — fine for forwarding yourself a notification, useless for signing up
an athlete. So the one-time code goes out through an HTTP email API.

The default is [Resend](https://resend.com): one `fetch` call, and its free
tier (3,000/month) is far more than a training log needs. Verify your domain
with them, then:

```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_FROM        # "Workouts <login@your-domain.com>"
```

Swapping it for Postmark, SES or anything else is one function in
`src/email.ts`.

**With no key set, the code is written to the log instead of sent.** That is
what makes local development work without signing up for anything, but it also
means a deployed Worker without `RESEND_API_KEY` cannot log anyone in who
cannot read your Worker logs.

Since anyone who can reach the page can ask for a code, set an allowlist if the
Worker is public:

```bash
npx wrangler secret put ALLOWED_EMAILS    # "me@example.com,@myteam.com"
```

Codes are six digits, stored only as a hash, good for 10 minutes and five
guesses, and one address may only ask for a code once a minute.

## Connecting an MCP client

The server speaks Streamable HTTP and is stateless — one JSON-RPC request per
POST, no sessions and no SSE, which is what keeps it inside the Workers free
plan.

**With OAuth**, which is what a client that can open a browser will do on its
own: point it at `https://<your-worker>/mcp` and it discovers the rest. The
client registers itself, sends you to a consent page, you sign in with your
email code and approve, and it gets a token. Nothing to copy.

The flow is OAuth 2.1 with mandatory PKCE and exact-match redirect URIs:

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource` | RFC 9728 — names the authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 — endpoint metadata |
| `POST /oauth/register` | RFC 7591 — dynamic client registration |
| `GET /oauth/authorize` | Consent page |
| `POST /oauth/token` | Code exchange and refresh |

Access tokens last 30 days; refresh tokens rotate on every use. Connected apps
are listed on the dashboard and can be revoked there, which kills the refresh
token too.

**With a static token**, for a client that only takes a header — mint one on
the dashboard under *Tokens*:

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
| `POST /api/auth/request-code` | `{email}` — send a login code |
| `POST /api/auth/verify` | `{email, code}` — sign in, sets the session cookie |
| `POST /api/auth/logout` | End the session |
| `GET /api/me` | Who you are |
| `GET /api/tokens` | List tokens and connected apps |
| `POST /api/tokens` | `{name}` — mint an API token, returned once |
| `DELETE /api/tokens/:prefix` | Revoke one |
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
src/auth.ts       login codes, sessions and bearer tokens
src/email.ts      sending the login code
src/oauth.ts      OAuth 2.1 for MCP clients
src/tools.ts      the tool surface shared by MCP and REST
src/mcp.ts        JSON-RPC over Streamable HTTP
src/index.ts      routing and auth
```

Every credential — hand-made API tokens and both halves of an OAuth grant —
lives in one `tokens` table, so there is a single lookup path in auth and one
place to revoke. Nothing is stored in the clear: sessions, login codes,
tokens and authorization codes are all SHA-256 hashes, and the dashboard shows
only a prefix.

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
SDK's own decoder.

```bash
npm test
npm run typecheck
```

## Cost

Everything here fits the Cloudflare free plan: Workers (100k requests/day),
D1 (5 GB, 5M row reads/day), static assets and cron triggers. Encoding a
30-step workout is well under the free plan's 10 ms CPU limit. Resend's free
tier covers the login emails. The only thing you pay for is the domain, and
Cloudflare Registrar sells those at cost.

Auth is self-contained rather than delegated to Auth0, Clerk, WorkOS or
Stytch. Those all have workable free tiers, and the MCP-focused ones will host
the OAuth server for you — but each adds an account every self-hoster of this
repo would also have to create. The only genuinely hard part to self-host is
*sending* the email, which is the one thing here that is outsourced.

## Licence

MIT — see [LICENSE](LICENSE).

This project depends on [`@garmin/fitsdk`](https://github.com/garmin/fit-javascript-sdk),
which Garmin ships under the **Flexible and Interoperable Data Transfer (FIT)
Protocol License**, not an OSI licence. Nothing from the SDK is vendored here —
it is an ordinary npm dependency — but if you redistribute a build, read
Garmin's terms first.
