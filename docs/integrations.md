# Training platforms

Connect a training platform and every workout you create, change or move is pushed to it,
every workout you delete is taken off it, and every session you record there comes back
here marked done.

**intervals.icu** is the first, and `src/platforms/` is built for there to be others: an
adapter is three functions — push a workout, remove one, list completions — handed the
athlete's access token on every call and storing nothing, so adding a platform is a new file
and a line in `PLATFORMS`. Three more are optional: `revoke`, and `activities`/`recording`,
which hand sessions over whole as files. `recording` is also where stats are read from when
a completion comes back, which is why a `Completion` names the activity behind it.

## Connecting intervals.icu

An OAuth round, not a pasted key. The callback stores the token and pushes whatever is
already planned straight away. Nothing is verified against intervals.icu first — their token
endpoint already answered with the athlete the grant belongs to.

Two scopes: `CALENDAR:WRITE` and `ACTIVITY:WRITE`. Write covers read, and naming
`ACTIVITY:READ` beside it is refused at their authorize page with *"Duplicate scope
ACTIVITY"*. A grant keeps its scopes for life, so an athlete who connected before this app
asked for `ACTIVITY:WRITE` gets a 403 on their notes until they press **Reconnect**, which
runs the round again on the existing row — new token, error cleared, links and pushed events
intact, which disconnect-then-connect would not be.

**Disconnecting hands the grant back** (`DELETE /api/v1/disconnect-app`), so the app
disappears from the athlete's own settings. A revocation we cannot deliver never fails the
disconnect, and it is skipped where another account here is connected to the same athlete,
because that call releases the *app* rather than one token of it.

`PUT /api/config/intervals` used to take a pasted key. It now answers 400 and says where the
door moved to.

## The credential is encrypted, not hashed

A platform access token has to be replayed on every push, so it cannot be a digest: it is
AES-GCM encrypted under a key derived from `CREDENTIALS_SECRET`, with a fresh nonce per
write.

```bash
npx wrangler secret put CREDENTIALS_SECRET   # any passphrase
```

Without it, connecting is refused outright rather than falling back to plaintext. Reading a
stored token back never throws: a rotated secret is a connection to make again, not a reason
for every workout from then on to fail.

## How a push works

- **The workout is sent as the FIT file a watch would get**, so there is no second
  serialiser to keep in step. Their text format would need one, and its repeats do not
  nest.
- **Tags go up as the event's own `tags`.** There is no upstream notion of a *key*
  session — their only ranked category is a race — so every workout we push stays a plain
  `WORKOUT`. The list is sent on every push, empty included, because a tag taken off here
  is only taken off there by arriving as its absence.
- **A push is an upsert**, keyed on the workout's own id in `external_id`, so it survives
  edits, moves and a lost link row. Their `uid` is theirs to mint and a supplied one is
  dropped, so upserting on it left a second event per edit.
- **A platform never fails your write.** An outage or a revoked grant is recorded against
  the connection and shown on the dashboard, bookkeeping included.
- **Only what changed is pushed**, off a digest of the plan as last pushed. `updated_at`
  cannot do that job: a completion read back off a platform bumps it, and the next sync
  would push the unchanged plan back over the platform's own report.
- **A delete that missed is owed, not forgotten.** The link row stays until the removal
  lands, because it is the only record of the event left to remove.
- **Our window is ours.** A workout ageing out of the 7/14-day window is not taken off
  your calendar.

Targets arrive absolute and are shown against the thresholds on your athlete profile, so
**a target reading wrong or showing `null-null` is a missing threshold there**, not a bad
file. The conversion is also lossy — they store a whole percentage, so the bpm shown can
sit a beat off what you planned.

## Completion arrives twice: a webhook, and an hourly backstop

Registered on their app page against `https://workouts-mcp.com/webhooks/intervals` with two
events ticked. **`ACTIVITY_ANALYZED`** is the one to rely on: it fires after they have had
the chance to pair the activity with the event we pushed — the pairing is the only thing
that says which workout was completed — and comes debounced by about a minute.
**`ACTIVITY_UPLOADED`** fires on arrival, usually before that pairing exists, and is taken
anyway as a second chance: it costs a read and risks nothing.

The webhook is a **nudge, not evidence**. The only thing the body is believed for is which
athlete it concerns; the pairing is read back over their API exactly as the polled path does
it, so a replayed or forged body cannot tick a session off.

The hourly cron is the backstop, and **Sync now** does it on demand. It is also the only
path for an activity that came from Strava, for which they send no webhook at all.

Applying a completion is where the session's stats are read: the paired activity is
fetched as a FIT file, reduced, stored against the workout and thrown away. The stored
stats are what says it has been done. A recording we could not read is logged and stepped
over rather than costing the completion. See [stats.md](stats.md).

### Proving a webhook is theirs

Two shared secrets, both compared as digests:

| Where | Binding | Note |
| --- | --- | --- |
| `secret` in the JSON body | `INTERVALS_WEBHOOK_SECRET` | Theirs; required, or the endpoint is a 503 |
| `Authorization` header | `INTERVALS_WEBHOOK_AUTHORIZATION` | Yours; only checked when set |

The header value is compared verbatim, `Bearer ` prefix included — there is no header
*name* to configure. The endpoint sits outside `/api/` so it never meets `withUser`: the
caller is intervals.icu authenticating itself.

A non-2xx is retried with exponential backoff, so the status is a request to come back
rather than a complaint: **2xx** for anything permanent (an unknown athlete, an event we
do not act on), **502** when their API could not be read back, **401** for a bad secret.
An event fans out to every connection matching the athlete, and the delivery is only
failed once they have all had a go.

Nothing goes the other way: ticking a session off here does not manufacture an activity
there. Completions are written straight to the database rather than through `src/plan.ts`,
so one that came from a platform cannot echo back out. Each is applied **exactly once**,
remembered on the link — without that, the next pass would tick an un-ticked session back
on and make the uncomplete button useless.

## The comment goes out, and never comes back

A comment written here is pushed to the recorded activity's description
(`PUT /api/v1/activity/{id}`, partial, so only that field is sent). It goes up as soon as
it is written if the recording has come back — the stats name the activity, the only
handle on the session there — and otherwise rides up with the completion. The description
comes back on the same listing the pairing does, so agreement costs no extra call.
`applied_comment` on the link remembers the note last handed over, so a refusal is not
retried hourly forever and an athlete's edit is a new note. No comment leaves their
description alone; *clearing* one clears it, because that is an instruction.

**Nothing is read back.** It was, briefly, and it was wrong: a recording app writes its
own line into the description on upload — `Workout performed with Watchletic.` — and that
got adopted as the athlete's own words on every review afterwards. `comment` is defined as
the athlete's own words, so only `comment_workout` and the REST verb write it. The
platform's text stays readable *as the platform's*, on `list_recorded_workouts`.

A Strava-sourced activity cannot be updated at all; that comes back as one of their errors
on the connection, and the note is stored here either way.

## What a sync run does

`syncNow` brings one platform back into step. Out of step is three things: a workout with no
link, a workout whose plan has changed since it was pushed, and a link naming no workout — a
delete that did not reach the platform. That last is only acted on while its date is inside
the retention window, since taking a session off an athlete's calendar on the strength of a
row we can no longer check is worse than leaving it; the nightly prune sweeps the rest.

One run pushes at most `PUSH_LIMIT` (40) workouts, removals included, because a Worker is
capped on outbound subrequests. Only stale workouts are pushed, so each run makes progress
and a first sync completes over more than one.

A run is the **only** thing that clears a standing error, and only when it finds nothing
left to do. **A failed push is not retried on a schedule** — the standing error is the
report, and acting on it is a choice.

The hourly pass takes a batch of connections per platform (`PULL_BATCH`, 40), oldest visit
first, stamping every connection it visits whether or not it was readable, because skipping
one silently would park the batch on it. Errors are per-athlete.

## intervals.icu API notes

- The athlete id in a path may be `0`, meaning "whoever the token belongs to".
- `POST /events/bulk?upsert=true` is create and update in one call, matched on our
  `external_id` and scoped to this OAuth app's events. The single-event `POST /events`
  offers only `upsertOnUid`, and `uid` is theirs to generate.
- Their calendar is keyed on the athlete's local day, which is what our `date` is.
- A call can succeed while the file inside it did not parse, so `push_errors` on the
  response is checked. A 404 on delete counts as removed.
