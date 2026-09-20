# How it is built

```
src/units.ts            parsing primitives: durations, paces, open-ended ranges
src/workout.ts          the plan: what a caller writes, what gets stored
src/resolve.ts          plan -> the model FIT needs, and the validator that proves it
src/fit.ts              FIT encoding, including flattening nested repeats
src/describe.ts         human-readable rendering, shared by MCP and the dashboard
src/db.ts               D1 queries, the readable window and the per-athlete cap
src/plan.ts             every write to the plan, and the platforms it tells
src/platforms/          training platforms: the interface, the store, intervals.icu
src/drive/              a scheduled copier, no routes of its own
src/recordings/         those same sessions as one signed, streaming ZIP download
src/identity.ts         signing in with Google or Apple
src/auth.ts             sessions, accounts and API tokens
src/context.ts          what an assistant reads before planning
src/tools.ts            the tool surface shared by MCP and REST
src/mcp.ts              the MCP surface, on the official SDK's handler
src/router.ts           a small path router: `:params`, and 405 apart from 404
src/http.ts             the context a route is given, and `withUser`
src/routes/             one module per group of routes, each declaring its own paths
src/app.ts              the OAuth provider's defaultHandler: the routing table
src/index.ts            the provider itself, and the two handlers it protects
src/client/             the React dashboard
```

## The request path

`src/index.ts` constructs the `OAuthProvider`, which claims the OAuth endpoints,
`/mcp` and `/api/app-token`, and passes everything else to `src/app.ts`. Both an
OAuth access token and one of our `wk_` tokens (via `resolveExternalToken`) reach
`/mcp` as the same props.

`/api/app-token` is the one path under `/api/` that `src/app.ts` never sees, and so
the one place a credential becomes an athlete outside `withUser`. See
[auth.md](auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).

`src/router.ts` matches patterns whose segments may be `:name`, optionally
constrained by a regex: `/api/workouts/:date(\d{4}-\d{2}-\d{2})/:id([0-9a-z]+)`. The
constraint is what keeps a nonsense path a 404 rather than a bad request from a
handler. A path that matches with no such method gets 405, not 404. HEAD is served
by the GET route.

## One door for writes

Every create, replace, move, delete and completion goes through `src/plan.ts`, whether it
arrived over REST or MCP — reading the row a write is about, carrying the completion
across it, and knowing the day a workout has left so its platform link can follow, all
live there once, and each caller only shapes the error. It is also the one place the
connected platforms hear about a change.

## Layering

`routes/` and `tools.ts` are HTTP and MCP shapes; `plan.ts` holds the rules for a write
and who to tell; `db.ts` storage, the window and the cap. `platforms/` is a sync layer
plus one adapter per platform, and nothing above it knows what intervals.icu is. An
adapter is stateless — handed the credential on every call — so the bookkeeping lives in
`platforms/store.ts` and `platforms/index.ts` rather than per platform. `drive/` and
`recordings/` sit beside them and nothing above calls into `drive/`.

## What is stored, and how

Nothing in the clear. Session ids and API tokens are SHA-256 hashes in D1; OAuth
grants live in KV. A platform access token has to be replayed, so it is AES-GCM
encrypted under `CREDENTIALS_SECRET`. See [auth.md](auth.md) and
[integrations.md](integrations.md).

## The dashboard

React, built by Vite, served as static assets, authenticated by the session cookie — so
`src/client/api.ts` does no token handling; one `request` helper turns a non-2xx into a
thrown `Error` carrying the server's message.

Workout dates are plain `YYYY-MM-DD`, a day rather than an instant, so every conversion
in `src/client/dates.ts` goes through *local* midnight — `toISOString` would push the
date back a day west of Greenwich.

One page: masthead, calendar, a **Setup** accordion, then the FAQ, all but the masthead
behind the session. The accordions are `<details>` sharing a `name`, so the browser
closes the siblings and there is no open-panel state — and a panel is opened from
elsewhere on the page by its `id`, which is how the empty calendar's *Connect Claude* and
*Get started with Claude* reach the connector URL and the starter prompt. An empty
calendar is usually an athlete who has not connected Claude yet, so those two doors sit
where the workouts would be. Each Setup panel fetches its own slice. Each context editor seeds its textarea from the server once and never re-seeds
it, so a save cannot overwrite what is being typed.

Two Vite entries: the dashboard and the OAuth consent screen. `public/privacy-policy.html`
is a static file with no script. `/workout/<id>` is the one page path the routing table
claims; the client resolves the id against the first list that arrives, which is where it
learns the day to open the panel on.
