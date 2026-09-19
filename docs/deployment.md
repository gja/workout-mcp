# Deploying

Everything runs on Cloudflare's free tier: one Worker, a D1 database, a KV namespace
and a static dashboard.

```bash
npm install
npx wrangler d1 create workout-mcp          # paste the id into wrangler.jsonc
npx wrangler kv namespace create OAUTH_KV   # paste that id in too
npm run db:remote                           # apply the migrations
npm run deploy
```

Then configure at least one sign-in provider (see [auth.md](auth.md)).

**Migrations are applied automatically on deploy**, by the Workers Build that runs on a
push, so a migration merged with the code that reads it is not an ordering hazard.
`npm run db:remote` is for standing the database up the first time.

Both ids are committed in `wrangler.jsonc`: they are account-scoped resource
identifiers, not secrets, and Cloudflare's build reads them from the repo.

## Local development

```bash
npm run db:local    # migrate a local D1
npm run dev         # everything at http://localhost:8787
```

Google sign-in works on localhost (loopback redirect URIs are allowed). Apple does not.
intervals.icu supports no wildcard redirect URIs and changing the registered ones means
emailing them, so it is practical on the deployed origin only.

## The deployed origin

Deployed at **`https://workouts-mcp.com`**. Three things are registered against that
origin upstream and have to be changed there if it moves:

| Registered with | Value |
| --- | --- |
| intervals.icu redirect URI | `https://workouts-mcp.com/auth/intervals/callback` |
| intervals.icu redirect URI | `https://workouts-mcp.com/auth/intervals/connect-callback` |
| intervals.icu webhook URL | `https://workouts-mcp.com/webhooks/intervals` |

Google's and Apple's redirect URIs are on the same origin, set in their own consoles.

## Secrets

| Secret | Needed for |
| --- | --- |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` | Apple sign-in |
| `INTERVALS_CLIENT_ID`, `INTERVALS_CLIENT_SECRET` | intervals.icu sign-in, and connecting it |
| `INTERVALS_WEBHOOK_SECRET` | Accepting their webhooks at all |
| `INTERVALS_WEBHOOK_AUTHORIZATION` | The header they send with one, when you set one |
| `CREDENTIALS_SECRET` | Connecting a training platform |
| `GOOGLE_DRIVE_CLIENT_EMAIL`, `GOOGLE_DRIVE_PRIVATE_KEY` | The copier in `src/drive/`; unset and it does nothing |

`APP_NAME` is an optional plain variable, shown on the dashboard and consent page.

## Scheduled work

Three crons, told apart in `src/index.ts` by which one fired.

- **`20 * * * *`** — read completions back off the platforms; a backstop for the
  intervals.icu webhook, which normally lands within a minute. It also reads their
  calendars, for the athletes who asked for what is planned there to be copied in.
- **`40 * * * *`** — the copier in `src/drive/`. Its own cron so it gets its own
  subrequest allowance rather than the sweep's leftovers.
- **`0 3 * * *`** — the same completion pass, plus credential housekeeping, a retry of
  connections stuck on an error, and a prune of platform links whose workouts are gone.

Workouts are never swept. See [database.md](database.md).

## Cost

Workers, D1, KV, static assets and cron triggers all fit the free plan; encoding a
30-step workout is well under the 10 ms CPU limit. You pay for the domain, and for an
Apple Developer membership if you want the Apple button.

There is no auth vendor in the stack. Auth0, Clerk, WorkOS and Stytch all have workable
free tiers, but each adds an account every self-hoster would have to create on top of
the Google client they need anyway. The protocol work is Cloudflare's library and
`arctic`, not ours.
