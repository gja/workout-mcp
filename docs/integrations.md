# Training platforms

A plan that only lives here is a plan you have to remember to export. Connect a
training platform on the dashboard and every workout you create, change or move
is pushed to it, every workout you delete is taken off it, and every session
you actually record there comes back here marked done.

**intervals.icu** is the first, and the layer it sits behind (`src/platforms/`)
is built for there to be others: an adapter is four functions — verify a
credential, push a workout, remove one, list completions — and knows nothing
about our storage, our routing or our window. Adding a platform is a new file
in that directory and a line in `PLATFORMS`, not another call site.

## Connecting intervals.icu

It takes an API key: in intervals.icu open **Settings** and find the
**Developer Settings** box at the bottom. Paste it into the Training platforms
section of the dashboard. The key is checked against intervals.icu before it is
stored, so a typo fails there and then, and whatever is already planned is
pushed straight away rather than trickling out as you next happen to edit
something.

## The credential is encrypted, not hashed

A session cookie is only ever compared against, so a one-way digest is enough
for it. A platform API key has to be replayed on every push, so it has to come
back out. It is AES-GCM encrypted under a key derived from
`CREDENTIALS_SECRET`, with a fresh nonce per write — so the same key stored
twice does not produce the same ciphertext, and a tampered row fails to decrypt
rather than decrypting to something else.

```bash
npx wrangler secret put CREDENTIALS_SECRET   # any passphrase
```

Without that secret there is nowhere safe to put a key, so connecting a
platform is refused outright rather than quietly falling back to plaintext, and
the dashboard says so. The check happens *before* the key is sent to be
verified, so a Worker with nowhere to store it does not hand it to a third
party first.

Reading a stored key back never throws, including when the secret is missing
entirely. A rotated or removed `CREDENTIALS_SECRET` makes every row
undecryptable, and that is a connection the athlete has to make again — not a
reason for every workout they write from then on to fail.

## How a push works

- **The workout is sent as the FIT file a watch would get.** intervals.icu
  accepts one on its calendar endpoint, so the structure that arrives is
  exactly the structure we encode — nested repeats, open-ended steps, every
  target type — with no second serialiser to keep in step with the first. Their
  text format would need one, and its repeats do not nest.
- **A push is an upsert, not an append.** Every workout carries a sync key of
  ours, built from ids rather than from the date or anything else the athlete
  can change, so it survives edits, moves and a lost link row. Re-pushing
  updates the event already there instead of piling up duplicates.
- **A platform never fails your write.** intervals.icu being down, or a key
  having been revoked, is recorded against the connection and shown on the
  dashboard; creating the workout still succeeds. The bookkeeping is inside
  that guard too, not only the push: a link table that refuses a write is still
  no reason for a workout that is safely stored to come back as a 500.
- **Only what changed is pushed.** Each link holds a digest of the plan as it
  was last pushed, so a run over a calendar already in step costs one list and
  no pushes. `updated_at` cannot do that job — recording a completion read back
  off a platform bumps it, and the next sync would then push the unchanged plan
  straight back out over a change the platform itself reported.
- **A delete that missed is retried.** A workout deleted here while
  intervals.icu was unreachable is taken off the calendar by the next sync, and
  by a nightly retry of any connection stuck on an error. The link row stays
  until the removal lands, because it is the only record of the event left to
  remove.
- **Our window is ours, not theirs.** A workout ageing out of the readable
  7/14-day window is not taken off your intervals.icu calendar.

## Completion is polled, not pushed

intervals.icu delivers webhooks only to OAuth applications it has approved, and
this integration is a key you pasted in, so there is no callback to register.
Instead, an hourly cron reads back the activities intervals.icu has paired with
the events we created — a recorded activity carries a `paired_event_id` — and
marks those workouts done. **Sync now** does the same on demand.

Nothing goes the other way: ticking a session off here does not manufacture an
activity there. A platform's own idea of a completed session is a recorded
activity, and inventing one from a tick box would put a session in the
athlete's training log that they never did.

Completions are written straight to the database rather than back through
`src/plan.ts`, so a completion that came from a platform cannot echo out to the
platform it just came from.

Each completion is applied **exactly once**, remembered on the link. An athlete
who un-ticks a session means it, and without that memory the next pass would
find the platform still reporting the activity and tick it back on, making the
uncomplete button useless on anything synced.

## What a sync run does

`syncNow` brings one platform back into step. Out of step is three things: a
workout with no link, a workout whose plan has changed since it was last
pushed, and a link that names no workout — a delete that did not reach the
platform.

A link naming no workout is only acted on while its date is still inside the
retention window. Outside it there is nothing useful to do: the date is past
reading, and taking a session off an athlete's own calendar on the strength of
a row we can no longer check is worse than leaving it. Those links are swept by
the nightly prune instead.

A Worker is capped on outbound subrequests per invocation, and the per-user
workout cap is above that cap, so one run pushes at most `PUSH_LIMIT` (40)
workouts, counting removals against the same budget. Only stale workouts are
pushed, so each run makes progress and a first sync of a full calendar
completes over more than one.

A run is the **only** thing that clears a connection's standing error, and only
when it finds nothing left to do. A single workout pushing cleanly says nothing
about the one that did not, and a connection with work still queued is not yet
in step.

## Scheduled passes

The hourly pass takes a batch of connections per platform (`PULL_BATCH`, 40),
ordered by when each was last visited. Every connection visited is stamped —
readable or not — because skipping one silently would park the batch on it and
quietly stop the sweep for everybody behind it. Errors are per-athlete: one
revoked key must not stop the sweep for anyone else.

The nightly pass adds a retry of up to `RETRY_BATCH` (10) connections carrying
a standing error. Nothing else picks these up: a push that failed is not
retried by the next workout written, since that one pushes only itself. Without
it, a session missing from a calendar because the platform was down for a
minute stays missing until an athlete notices and presses Sync now.

## intervals.icu API notes

Three things about their API shape `src/platforms/intervals.ts`:

- The athlete id in a path may be `0`, meaning "whoever the credential belongs
  to", so nothing has to look an athlete up before writing.
- Creating an event takes `upsertOnUid`, so create and update are the same call
  under a key we choose.
- The event endpoint accepts a FIT workout file, which is how the structure
  survives intact.

Their calendar is keyed on the athlete's local day, which is exactly what our
`date` is, so midnight local is the honest start. A call can succeed while the
file inside it did not parse, leaving an event with no steps — the response's
`push_errors` is checked, because recording a clean sync for a calendar entry
the athlete cannot train off is worse than saying so. A 404 on delete counts as
removed: already gone is the state we were asking for.
