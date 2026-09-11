# Syncing to Garmin Connect

[← back to the README](../README.md)

The plan goes out; what the athlete actually did comes back. Those are the two
halves, and they are not symmetrical — see **Taking completions back** below
for why completion only travels one way.

A FIT file you drop on a watch is one way to get a session onto it. The other
is the athlete's own Garmin Connect calendar: put a workout on a date there and
the watch picks it up on its next sync, with no cable and no file.

That is what this does. Connect a Garmin account once from the dashboard, and
every planned workout in the retention window is pushed to the calendar — on
request, or nightly on its own.

```
Connect once   dashboard → Garmin's consent screen → back, with tokens stored
Then           every write syncs itself — plus "Sync now", sync_workouts, or cron
```

## Setting it up

Syncing needs a [Garmin Connect Developer Program](https://developer.garmin.com/gc-developer-program/overview/)
app with the **Training API** enabled. That is a partner application Garmin
approves by hand rather than a self-service signup, and it is the one part of
this repo you cannot stand up on your own in an afternoon. Everything else
works without it; the Garmin panel simply does not appear until the two
secrets below are set.

```bash
npx wrangler secret put GARMIN_CLIENT_ID
npx wrangler secret put GARMIN_CLIENT_SECRET
npx wrangler secret put GARMIN_ENCRYPTION_KEY   # optional, see below
npm run db:remote                               # migrations 0005 to 0007
```

Register `https://<your-worker>/garmin/callback` as the app's redirect URI, exactly.
Garmin matches it literally, so a local install needs
`http://localhost:8787/garmin/callback` registered as well.

`GARMIN_ENCRYPTION_KEY` is optional and worth setting. Garmin's tokens have to
be stored recoverably — unlike every other credential here, we hand the real
value back to Garmin on each call — so they are encrypted at rest with
AES-GCM rather than hashed. The key is derived from `GARMIN_ENCRYPTION_KEY`
when it is set and from `GARMIN_CLIENT_SECRET` otherwise, which means that
without it, rotating the client secret makes the stored tokens unreadable and
everyone has to reconnect. The stored row names the key it was sealed with, so
that case is reported as "connect again" rather than failing somewhere deeper.

## Connecting

`GET /garmin/connect` starts an OAuth 2.0 authorization-code flow with PKCE —
Garmin's own, unrelated to the OAuth this app *serves* to MCP clients. This app
is the client here, as it is with Google:

| Endpoint | Purpose |
| --- | --- |
| `GET https://connect.garmin.com/oauth2Confirm` | Garmin's consent screen |
| `POST https://diauth.garmin.com/di-oauth2-service/oauth/token` | Code exchange and refresh |
| `GET https://apis.garmin.com/wellness-api/rest/user/id` | Garmin's id for the athlete |
| `DELETE https://apis.garmin.com/wellness-api/rest/user/registration` | Deregistration, on disconnect |

The in-flight state and the PKCE verifier live in D1, single use with a
ten-minute life, and the state row names the athlete who started the flow — a
callback finished under a different account is refused rather than attaching a
Garmin account to the wrong workouts. Access tokens last a day and are
refreshed five minutes before they lapse, because a sync is several calls and
one expiring halfway through would leave the run half-applied. Garmin rotates
the refresh token on every use, so the new pair replaces the old one.

Proactive refreshing cannot predict a token invalidated behind our back, so a
401 *during* a run earns one retry: refresh, try that call again, and treat a
second 401 as the grant genuinely being gone. Once per run — retrying forever
would spend the whole call budget proving the same thing.

Disconnecting tells Garmin as well as forgetting our own row. **Workouts
already on the calendar stay there** — disconnecting is "stop sending", not
"undo the training plan".

## What a sync does

One of our workouts becomes two things on Garmin's side, and the distinction is
the whole model: a **workout** is the session, and lives in the athlete's
library; a **schedule** attaches it to a day, and *that* is the calendar entry
a watch reads. So moving a session to another day replaces the schedule while
keeping the workout.

A sync is a diff, not a re-upload. `garmin_workouts` records what each of ours
became — the Garmin workout id, the calendar entry id, and a fingerprint of the
payload last sent — and a run does the smallest thing that reconciles the two
sides:

| Locally | On Garmin |
| --- | --- |
| new | create the workout, then schedule it |
| changed | update the workout in place, calendar entry untouched |
| moved to another day | update it, then replace the calendar entry |
| unchanged | nothing at all, and no Garmin call |
| deleted | remove the calendar entry, then the workout |
| aged out of the window | **left alone**, and no longer tracked |
| deleted on Garmin's side | drop the stale link and put the session back |

A sync only reaches for a workout it has a reason to touch, which is what makes
repeating it free — and also the limit of that last row. A session the athlete
deletes in the Connect app changes nothing here, so an ordinary sync sees it as
unchanged and never finds out. It is noticed the next time that workout changes
here, or immediately on a **Re-send everything** (`force`), which re-sends the
lot and so discovers the id that names nothing. The alternative — reading every
workout back from Garmin on every run — would cost a call per workout and throw
away the property that makes syncing cheap, to catch something the athlete did
themselves and can undo with one button.

Which makes syncing safe to repeat: the same plan synced twice costs nothing
and changes nothing the second time.

That last row is the one worth stating outright. A workout can leave this
server two ways — the athlete deleted it, or it fell off the back of a 7-day
retention window — and those want opposite treatment. A deleted session should
disappear from the calendar. A session that merely aged out is *training the
athlete has done*, and deleting that from their Garmin history because our
retention happens to be short would be indefensible. So a link whose date is
still inside the window with no workout behind it was deleted, and is removed;
one whose date has fallen outside it stays on Garmin and merely stops being
tracked here.

The link is keyed by our workout id alone rather than by *(date, id)* as
`workouts` is. The id survives a workout being moved, and that is exactly the
case that has to update the existing Garmin workout rather than leave a
duplicate behind on the old date.

If a workout is created on Garmin but the scheduling call then fails, the link
is written anyway with a null calendar entry. The next run reads that as
"created, still needs a date" and makes the one call it should, instead of
creating a second copy of a workout that is already up.

Once noticed, recovery matters more than it looks: without it, an athlete who
tidied a synced session out of the Connect app would have every later sync fail
on that id, for good, until they disconnected and started over.

A run is capped at 30 Garmin calls, because a Worker gets a bounded number of
outbound subrequests per *invocation* — 50 on the free plan this fits inside —
and a workout costs up to four. A run that hits the cap says so
(`truncated: true`) and the next one picks up where it stopped; nothing is
lost, because the diff is computed from stored state rather than from a cursor.

The invocation is the unit, not the athlete, and that distinction is the whole
point of the budget. The nightly sweep looks at up to five athletes, sharing
one budget between them: five separate budgets would have authorised 150 calls
against a limit of 50, and the calls past it fail as unreachable-network errors
— which would be reported as *the athlete's workouts failing* rather than as
this server running out of room. Sharing it means the sweep degrades into "some
athletes wait for tomorrow" instead of "the last four athletes look broken",
and `autoSyncUserIds` orders by how long it has been, so the ones it skipped
are first in line next time.

### One sync at a time

An athlete's sync takes an advisory lock, in `sync_locked_at` on their
connection row. Two runs at once — the 03:00 sweep while the athlete presses
*Sync now* — would both read the same links, both see a workout as new, and
both create it; the loser's `saveLink` would then overwrite the winner's,
orphaning a Garmin workout and a calendar entry that no later diff can see, let
alone remove. A duplicate on the calendar, for good.

The lock is claimed with a single conditional `UPDATE`, which SQLite applies
atomically, so exactly one of the two sees a changed row and proceeds; the
other is told a sync is already running (a **409**, not an error). It is
released in a `finally`, and the stored timestamp makes it self-healing: a run
whose isolate was evicted mid-flight holds it only until it goes stale, five
minutes out. A dry run neither takes the lock nor waits for one — looking at
what a running sync is doing is exactly the thing to be able to do while it
runs.

## Taking completions back

Whether a session happened is not something this server can know. The watch
knows, and Garmin's calendar takes no "done" flag from us — so there is nothing
to push in that direction and no point pretending otherwise. What there is, is
the Activity API: a record of what the athlete recorded. Every sync finishes by
reading it and ticking off the sessions it accounts for.

> **The transport described here is wrong.** Garmin's Activity API is
> webhook-based (PING/PUSH), not the polling this does, so none of the
> fetching below will get answers from the real API. The *matching* is
> unaffected and is the part worth reading. See **What has been checked
> against Garmin's own docs** below.

| | |
| --- | --- |
| Endpoint | `GET apis.garmin.com/activity-api/rest/activities` |
| Windowed by | `uploadStartTimeInSeconds` / `uploadEndTimeInSeconds`, 24 hours per request |
| Lookback | 3 days of upload time, so 3 calls — uploads lag the activity |

**Matching.** An activity completes a workout when it falls on the same day and
is the same sport. The day is the athlete's *local* day —
`startTimeInSeconds + startTimeOffsetInSeconds` — because a 06:30 run in
Auckland is the previous day in UTC and the plan was written for the day they
would name. Sports are recognised by family rather than by an exhaustive
table: `TRAIL_RUNNING`, `VIRTUAL_RUN` and `TREADMILL_RUNNING` are all running,
and Garmin keeps adding entries to that enum, so a list would silently fail to
match whatever it omits. A `generic` plan accepts any sport, since that is what
generic means.

Each activity completes at most one workout and each workout takes at most one
activity, so two sessions on a day need two activities. Where a day holds more
than one candidate the closest by planned duration wins — otherwise an easy
hour and a hard twenty minutes on the same Tuesday would be ticked off by
whichever came back first.

**Two rules matter more than the matching.**

*Only ever set, never clear.* A workout Garmin has no activity for is left
exactly as it is. Garmin not knowing about a session is not evidence it did not
happen — a treadmill run logged by hand here has no activity behind it — and
erasing the athlete's own tick because a third party has not heard of it would
be indefensible. The corollary is worth stating: clearing a completion by hand
while Garmin still holds the activity that justified it will see it come back
on the next sync. Garmin is authoritative for *done*; this server is
authoritative for the plan.

*Already-completed workouts are skipped.* That is what makes the pull
idempotent, and what makes it cheap — a window of nothing but future sessions
needs no activity query at all, because a session planned for Thursday cannot
have been done on Monday.

A write triggers a sync on its own, so this runs whenever the plan changes as
well as nightly and on request. The pull is the optional half, and is ordered
and budgeted as such. It runs
after the push, so a run short of calls spends them getting sessions onto the
watch before it spends any reading history; and a refused or unreachable
activity query leaves a note on the report rather than failing the sync, whose
real work is already done. A completion is written through `db.setCompleted` —
the same write the dashboard's tick uses — so a session completed from Garmin
is indistinguishable from one ticked by hand. There is one notion of done.

## What does not survive the trip

The Training API cannot express everything a FIT file can, and the mapping in
`src/garmin/payload.ts` reports each loss rather than swallowing it. Every
sync result carries the notes per workout, and the dashboard shows them.

- **A step has one `description`**, where FIT has both a name and a note. The
  name, the note, and anything else below are folded into it in that order.
- **One target per step.** FIT stores a primary and a secondary — "400m at
  4:00/km and 180 spm" — so the secondary becomes prose in the description.
- **Both ends of a range are required.** An open end becomes the metric's own
  extreme, which says the same thing without inventing a bound: "above
  140 bpm" is sent as 140–255, the same limits `target_heart_rate` already
  accepts.
- **Sub-sports are mapped only where a Garmin name is unambiguous.** Getting
  one wrong is a small loss; sending an enum Garmin does not know fails the
  whole workout, which is a large one. Anything unmapped is left off.

## What has been checked against Garmin's own docs

The Developer Program is paused, so none of this can be exercised end to end.
What follows was checked against Garmin's own OAuth2.0 PKCE specification PDF
and their developer-portal material — a primary source, not community
writeups — and is recorded here rather than only in a pull request, so the
next person to pick it up starts from it.

**Confirmed correct.** The authorize URL and its parameters, the token URL, and
`GET /wellness-api/rest/user/id` / `DELETE /wellness-api/rest/user/registration`
all match the spec exactly. So does the assumed access-token lifetime: the
spec's own example gives `expires_in: 86400`, a day. Garmin's prose elsewhere
says access tokens last three months, which is `refresh_token_expires_in`
(~90 days) in the wrong sentence — their documentation error, not ours.

**Fixed.** `REFRESH_MARGIN_MS` was five minutes; the spec asks for at least
600 seconds of safety margin, so it is ten.

**Outstanding: permissions are never checked.** Garmin documents
`GET /wellness-api/rest/user/permissions`, and an athlete grants permissions
*individually* — `WORKOUT_IMPORT` for the push, `ACTIVITY_EXPORT` for the
completions. Nothing here reads that, so a partial grant fails silently on
whichever half was not authorised instead of saying so. Two things to do: ask
for both permissions in the portal's app registration, and check the granted
set at connect time so a half-grant is reported rather than discovered.

**Outstanding: the completion pull is built on the wrong transport.** This is
the big one, and the section above describes how it *works*, not how Garmin
works. See the header of `src/garmin/activities.ts`, which spells it out — in
short, the Activity API is PING/PUSH webhook-based, not pollable, so
`fetchActivities`, `uploadWindows` and `completableRange` need replacing with a
receiver plus a connect-time backfill. The matching below the fetch survives
that unchanged, because pairing an activity with a planned session is the same
problem whichever way the activity arrived.

**Still unverified**, being behind the portal login: the PING/PUSH payload
field names, the backfill endpoint's parameters, any signature scheme for
inbound webhook calls, and the Training API's precise workout schema — that
last one being the risk the next section is about.

## Verifying the payload against your own docs

The Training API's request schema is documented behind the developer portal's
login, which is not something a repo can vendor. The mapping here follows that
schema as publicly described, and the code is arranged so that correcting a
field name is a one-line change if your portal docs differ:

- every enum is a flat `Record` at the top of `src/garmin/payload.ts`, and the
  activity-type patterns a short list at the top of `src/garmin/activities.ts` — sports,
  sub-sports, intensities, zone target types, the open-range fills;
- `buildWorkout` is pure, with no clock, network or connection in it, so
  `sync_workouts` with `dry_run` and `include_payloads` hands back the exact JSON
  it would have posted, without posting it;
- `GarminApiError` carries Garmin's own status and response body, and the sync
  report repeats it verbatim per workout — so a refused payload tells you which
  field to fix rather than failing mysteriously.

The fields most worth checking first, being the ones a schema is most likely to
spell differently: `segments[].steps[].targetValueType` for percentage targets
(`PERCENT_MAX_HEART_RATE`, `PERCENT_FTP`), and `targetType: "PACE"` with its
values in metres per second.

## The surface

| Route | Does |
| --- | --- |
| `GET /garmin/connect` | Start the flow; redirects to Garmin |
| `GET /garmin/callback` | Finish it; back to the dashboard |
| `GET /api/garmin/status` | Connected? last synced? how many tracked? |
| `PUT /api/garmin/settings` | `{auto_sync}` — nightly sync on or off |
| `POST /api/garmin/disconnect` | Unlink, and tell Garmin |

| `GET /activity-api/rest/activities` | Read back what the athlete recorded (3 slices) |

Syncing itself is not here: it is provider-neutral, at `POST /api/sync` and the
`sync_workouts` tool, so one action covers every platform the athlete has
linked. These routes are about the *connection*, which is the part that cannot
be generalised — see *Adding a platform* in the README.

There is no Garmin-named sync tool, and no Garmin-specific sync endpoint, on
purpose. A write already syncs on its own, and when it does not the athlete
wants "put my plan where my watch will see it" rather than "talk to Garmin".
