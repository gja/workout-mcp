# How it is built

```
src/units.ts      parsing primitives: durations, paces, open-ended ranges
src/workout.ts    the plan: what a caller writes, what gets stored
src/resolve.ts    plan -> the model FIT needs, and the validator that proves it
src/fit.ts        FIT encoding, including flattening nested repeats
src/describe.ts   human-readable rendering, shared by MCP and the dashboard
src/db.ts         D1 queries, the readable window and the per-athlete cap
src/plan.ts       every write to the plan, and the platforms it tells
src/platforms/    training platforms: the interface, the store, intervals.icu
src/drive/        copying recorded sessions into an athlete's own Google Drive
src/recordings/   those same sessions as one signed, streaming ZIP download
src/identity.ts   signing in with Google or Apple
src/auth.ts       sessions, accounts and API tokens
src/tools.ts      the tool surface shared by MCP and REST
src/mcp.ts        JSON-RPC over Streamable HTTP
src/router.ts     a small path router: `:params`, and 405 apart from 404
src/http.ts       the context a route is given, and `withUser`
src/routes/       one module per group of routes, each declaring its own paths
  signin.ts         /auth/* and /api/auth/logout
  oauth.ts          /oauth/authorize and /oauth/client: how an MCP client gets in
  account.ts        /api/me, /api/tokens, /api/connections
  integrations.ts   /api/config and /api/sync: training platforms and the drive
  workouts.ts       /api/workouts, /api/tools and /export
src/app.ts        the OAuth provider's defaultHandler: the table the rest mount onto
src/index.ts      the provider itself, and the protected /mcp handler
src/client/       the React dashboard
```

## The request path

`src/index.ts` constructs the `OAuthProvider`, which wraps everything: it
claims the OAuth endpoints and `/mcp`, and passes every other request to
`src/app.ts`. Two kinds of credential reach `/mcp` — an OAuth access token the
provider issued, and one of our own `wk_` tokens resolved by
`resolveExternalToken` — and both arrive at the handler as the same props.

`src/app.ts` is only the routing table: it builds the router and mounts each
group from `src/routes/`, which keeps every path next to the handler that
answers it. A route is a single handler, and the ones declared through
`withUser` are given the athlete they are acting for, so no handler has to read
a cookie or a bearer token. A path the table does not claim is the dashboard —
except under `/api/` and `/export/`; see [api.md](api.md).

`src/router.ts` exists so routing reads as a table rather than a chain of
`startsWith` checks. Patterns are paths whose segments may be `:name`,
optionally constrained by a regular expression:
`/api/workouts/:date(\d{4}-\d{2}-\d{2})/:id([0-9a-z]+)`. A constraint is what
keeps a nonsense path a 404 rather than letting it reach a handler that would
call it a bad request. A path that matches but offers no such method gets 405
rather than falling through to 404, so "no such route" and "not that way" stay
distinct. HEAD is served by the GET route, as the method is defined to be.

## One door for writes

Every create, replace, delete and completion goes through `src/plan.ts`,
whether it arrived over REST or as an MCP tool call. Before that module,
`routes/workouts.ts` and `tools.ts` each had their own copy of the same
three-step dance — read the old row, carry the completion across, delete before
a move — and a change to the rules meant finding both. Now the rules are there
once, and each caller only shapes the answer: a 404 on one side, a `ToolError`
on the other.

It is also the one place the connected platforms hear about a change, which is
what keeps them in step no matter which door the write came in through.

## Layering

```
routes/ + tools.ts     HTTP and MCP shapes
      ↓
plan.ts                the rules for a write, and who to tell
      ↓
db.ts                  storage, the window, the cap
platforms/             the sync layer, then one adapter per platform
drive/                 recordings out of a platform and into the athlete's own Drive
recordings/            those same recordings out as one signed ZIP download
```

Nothing above `src/platforms/` knows what intervals.icu is: `plan.ts` calls the
sync layer, the sync layer walks the registry, and only the adapter knows what
an event or an athlete id is. An adapter is stateless — handed the credential
on every call, storing nothing — so the "which athlete, which row, which error"
bookkeeping lives in `platforms/store.ts` and `platforms/index.ts` rather than
being re-implemented per platform.

## What is stored, and how

Nothing is stored in the clear. Session ids and API tokens are SHA-256 hashes
in D1; OAuth grants and their tokens are the library's problem, in KV. A
training platform's access token is the one credential that cannot be hashed,
because it has to be replayed on every push, so it is AES-GCM encrypted under
`CREDENTIALS_SECRET`. See [auth.md](auth.md) and
[integrations.md](integrations.md).

## The dashboard

React, built by Vite, served as static assets. It is authenticated by the
session cookie, so `src/client/api.ts` does no token handling; every call goes
through one `request` helper that turns a non-2xx into a thrown `Error`
carrying the server's own message.

Workout dates are plain `YYYY-MM-DD` — a day on a calendar, not an instant — so
every conversion in `src/client/dates.ts` goes through *local* midnight.
`toISOString` would push the date back a day for anyone west of Greenwich.

One page, in a fixed order: masthead, calendar, a **Setup** accordion, then the
FAQ. Setup holds the five panels — Integrations, Google Workspace Drive, Connect
to Claude, API tokens, Connected apps — and each is a component that fetches its
own slice, so opening one does not wait on the others. The accordion is `<details>` elements sharing a
`name`, which is what makes a browser close the siblings: there is no open-panel
state in React, and the panels still work with JavaScript half-loaded. The FAQ
uses the same pair and renders signed out as well, which is the only part of the
page a first-time visitor sees. Under it, one link: the privacy policy.

Two Vite entries, not one: the dashboard and the OAuth consent screen. The
privacy policy is neither — `public/privacy-policy.html` is a static file with
its own inline styles and no script at all, copied through the build and served
by the assets binding at `/privacy-policy`, extension and all handled there.
`/workout/<id>` is the one page path the table does claim: it is not a file, so
`src/app.ts` answers it with the dashboard, and the client resolves the id
against the first list that arrives, because an id is only unique within a
date. A workout outside the window is a note rather than an empty calendar.
