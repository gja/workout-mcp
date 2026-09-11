# Deploying

Everything runs on Cloudflare's free tier: one Worker, a D1 database, a KV
namespace and a static dashboard.

## Quick start

```bash
npm install
npx wrangler d1 create workout-mcp          # paste the id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # paste that id in too
npm run db:remote                           # apply the migrations
npm run deploy
```

Then configure at least one sign-in provider (see [auth.md](auth.md)) and open
the dashboard.

Both ids belong in `wrangler.jsonc` and are committed: they are resource
identifiers scoped to your account, not secrets, and Cloudflare's build has to
read them from the repo. A fork will need its own.

## Local development

```bash
npm run db:local    # migrate a local D1
npm run dev         # everything at http://localhost:8787
```

Google sign-in works on localhost — Google allows loopback redirect URIs. Apple
does not, so that button is only usable on a real domain. intervals.icu does not
support wildcard redirect URIs, and changing the registered ones means emailing
them, so it is practical on the deployed origin only.

## The deployed origin

This is deployed at **`https://workouts-mcp.com`**. Three things are registered
against that origin upstream and have to be changed there, not here, if it ever
moves:

| Registered with | Value |
| --- | --- |
| intervals.icu redirect URI | `https://workouts-mcp.com/auth/intervals/callback` |
| intervals.icu redirect URI | `https://workouts-mcp.com/auth/intervals/connect-callback` |
| intervals.icu webhook URL | `https://workouts-mcp.com/webhooks/intervals` |

Google's and Apple's redirect URIs are on the same origin and are set in their
own consoles.

## Secrets

| Secret | Needed for |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple sign-in |
| `INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET` | intervals.icu sign-in, and connecting it |
| `INTERVALS_WEBHOOK_SECRET` | Accepting their webhooks at all |
| `INTERVALS_WEBHOOK_AUTHORIZATION` | The header they send with one, when you set one |
| `CREDENTIALS_SECRET` | Connecting a training platform |
| `GOOGLE_DRIVE_CLIENT_EMAIL`, `GOOGLE_DRIVE_PRIVATE_KEY` | Copying recorded sessions to an athlete's Google shared drive |

`APP_NAME` is an optional plain variable, shown on the dashboard and the
consent page.

## Scheduled work

Three crons, told apart in `src/index.ts` by which one fired.

- **Hourly (`20 * * * *`)** — a backstop for the intervals.icu webhook, which
  normally marks a session done within a minute: read completions back off the
  connected training
  platforms. There is no webhook to subscribe to; see
  [integrations.md](integrations.md).
- **Hourly (`40 * * * *`)** — copy any new race into the drive an athlete
  configured. Its own cron rather than a second job on the pass above, so it
  gets its own subrequest allowance instead of that sweep's leftovers; see
  [drive.md](drive.md).
- **Nightly (`0 3 * * *`)** — the same completion pass, plus credential
  housekeeping (expired sessions, abandoned sign-ins, stale OAuth grants), a
  retry of platform connections stuck on an error, and a prune of platform
  links whose workouts are long gone.

Workouts are deliberately never swept. See [database.md](database.md).

## Cost

Workers (100k requests/day), D1 (5 GB, 5M row reads/day), KV, static assets and
cron triggers all fit the free plan. Encoding a 30-step workout is well under
the 10 ms CPU limit. Google sign-in is free. The only things you pay for are
the domain — Cloudflare Registrar sells those at cost — and, if you want the
Apple button, an Apple Developer Program membership.

There is no auth vendor in the stack. Auth0, Clerk, WorkOS and Stytch all have
workable free tiers, and the MCP-focused ones will host the whole authorization
server — but each adds an account every self-hoster of this repo would also
have to create, on top of the Google client they need anyway. The protocol work
is Cloudflare's library and `arctic`, not ours.
