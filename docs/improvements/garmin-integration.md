# Garmin Connect as a platform adapter

**Status: parked.** Garmin's Developer Program is paused, so a portal
registration — and the documentation behind its login — cannot be had. Pick
this up when that reopens.

Prior art: PR #11, at `fb31752` on `refs/pull/11/head`. It built Garmin against
a sync layer of its own, before #15 landed `src/platforms/`. The layer is now
canonical and Garmin should be one adapter under it, so most of that PR is
superseded. These four files are not, and are worth lifting nearly as they are:

| From `fb31752` | What it is |
| --- | --- |
| `src/garmin/oauth.ts` | OAuth2 PKCE: consent URL, code exchange, refresh, deregister |
| `src/garmin/payload.ts` | A plan → the Training API's workout JSON. Pure, and lossy in named ways |
| `src/garmin/api.ts` | The Training API client: workouts, and calendar entries |
| `src/garmin/activities.ts` | Matching a recorded activity to a planned session |

Also there: `docs/garmin.md` (including what is and is not verified against
Garmin's own specification) and a Garmin half of `test/upstream-provider.js`.

## What Garmin asks of the `Platform` contract

Three things intervals.icu did not need. The first two are real contract
changes; the third is the adapter's own business.

**1. A credential that rotates.** `verify(key: string)` and
`store.credentialFor` assume a static string. Garmin's is an access/refresh
pair, and Garmin issues a *new* refresh token on every refresh — so a push has
to be able to write its credential back. Suggested minimum: store the token
bundle as JSON in the existing `secret` column (opaque to the layer already),
add `Platform.refresh?(key): Promise<string | null>`, and have the layer call
it before use and persist what comes back. Nothing else in `store.ts` changes.

**2. A browser round trip to connect.** `PUT /api/platforms/:platform` takes a
pasted `{key}`. Garmin needs `GET /garmin/connect` → Garmin's consent screen →
`GET /garmin/callback`. That means:

- `Platform.credential` becomes a union — a paste field, or an OAuth flow with
  a connect path — so `Platforms.tsx` renders a button instead of an input.
- Two browser routes, which must redirect on a missing session rather than
  answer a JSON 401. `withUserOrSignIn` in #11's `src/http.ts` is that helper.
- Somewhere for the in-flight PKCE state and verifier: `migrations/0006`, one
  table, single-use with a ten-minute life, following `identity.ts`. The row
  must name the athlete who started the flow, or a callback finished under a
  different account attaches Garmin to the wrong workouts.

**3. Two upstream objects per workout.** A Garmin *workout* lives in the
library; a *schedule* attaches it to a day, and that is the calendar entry a
watch reads. `push` returns one id, so pack both (`workoutId:scheduleId`) into
`remote_id` and split it in the adapter; `remove` deletes both. A move needs no
special case — `fingerprint` covers `date`, so the adapter reschedules on any
push. Note that a create is then **two** outbound calls, which `PUSH_LIMIT`
counts as one.

## Land the push side first

`completions()` should return `[]` for Garmin to begin with, and the adapter
should say so. Two reasons, both outstanding:

- **The Activity API is PING/PUSH, not pollable.** Garmin calls a webhook when
  a device syncs; pre-connection history needs a one-time `backfill/activities`
  whose results also arrive that way. So there is nothing for an hourly cron to
  read. A receiver, a backfill at connect time and Garmin's inbound signature
  scheme are all a separate piece of work, and all behind the portal login.
- **Nothing comes pre-paired.** intervals.icu hands back a `paired_event_id`;
  Garmin hands back activities. Pairing is `matchCompletions` in
  `activities.ts` — local day, sport family, then closest planned duration —
  which resolves a *workout*, not a `remote_id`. Either map back through the
  link table or widen `Completion`.

## Before writing any payload code

- Read `GET /wellness-api/rest/user/permissions`. An athlete grants
  `WORKOUT_IMPORT` and `ACTIVITY_EXPORT` **individually**, so a partial grant
  fails silently on one half. The portal registration needs both.
- The Training API's workout schema was never verified — the portal was already
  closed. `payload.ts` keeps every enum as a flat `Record` at the top for that
  reason, and `GarminApiError` repeats Garmin's own status and body per
  workout, so a refused payload names the field to fix. Check the schema first
  and the enums will be the only thing that moves.

## Checklist

- [ ] `'garmin'` in `PlatformId` and `PLATFORMS`
- [ ] `GARMIN_CLIENT_ID` / `GARMIN_CLIENT_SECRET`, and hide the platform from
      `status()` when they are unset
- [ ] `migrations/0006` for the in-flight connect flow
- [ ] The contract changes above, with intervals.icu unaffected
- [ ] Garmin in the test stand-in, and `docs/garmin.md` restored — as a Garmin
      section of `docs/integrations.md`, or its own file. A new top-level
      `docs/` file needs a 50-100 word README entry: `scripts/check-readme.mjs`
      enforces it, and does not look in this directory.
