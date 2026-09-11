# Training platforms

A plan that only lives here is a plan you have to remember to export. Connect a
training platform on the dashboard and every workout you create, change or move
is pushed to it, every workout you delete is taken off it, and every session
you actually record there comes back here marked done.

**intervals.icu** is the first, and the layer it sits behind (`src/platforms/`)
is built for there to be others: an adapter is three functions — push a
workout, remove one, list completions — and knows nothing about our storage,
our routing or our window. It is handed the athlete's access token on every
call and stores nothing. Adding a platform is a new file in that directory and
a line in `PLATFORMS`, not another call site.

An adapter may offer three more, all optional. `revoke` hands the token back
when an athlete disconnects. `activities` and `recording` are how the sessions
an athlete records get copied to their own Google Drive; only `src/drive/` asks
for those, and only if they are offered — see [drive.md](drive.md).

## Connecting intervals.icu

It is an OAuth round, not a pasted key: press **Connect intervals.icu** in the
**Integrations** panel, allow access on their site, and the callback stores the
token and pushes whatever is already planned straight away rather than letting
it trickle out as you next happen to edit something.

Nothing is verified against intervals.icu first. Their token endpoint answers
with the athlete the grant belongs to, so a call asking who it is would only
repeat what we were already told.

Signing in *with* intervals.icu leaves you connected without a second round —
see [auth.md](auth.md), which also covers the two redirect URIs and why an
intervals.icu sign-in never joins an existing account.

**Disconnecting hands the grant back**, calling their
`DELETE /api/v1/disconnect-app`, so the app also disappears from the athlete's
own intervals.icu settings rather than lingering there unused. A revocation we
cannot deliver never fails the disconnect: forgetting our copy is still what
they asked for, and they can revoke it themselves.

### There is no key to paste any more

`PUT /api/config/intervals` used to take one. It now answers 400 and says
where the door moved to, rather than 404: anything still sending a key deserves
to be told. Migration 0007 clears the connections that held one, because a key
in a bearer header is a 401 on every push — a cleared connection offers
**Connect**, where a kept one would report someone else's outage forever.

## The credential is encrypted, not hashed

A session cookie is only ever compared against, so a one-way digest is enough
for it. A platform access token has to be replayed on every push, so it has to
come back out. It is AES-GCM encrypted under a key derived from
`CREDENTIALS_SECRET`, with a fresh nonce per write — so the same key stored
twice does not produce the same ciphertext, and a tampered row fails to decrypt
rather than decrypting to something else.

```bash
npx wrangler secret put CREDENTIALS_SECRET   # any passphrase
```

Without that secret there is nowhere safe to put a token, so connecting a
platform is refused outright rather than quietly falling back to plaintext, and
the dashboard says so. A sign-in with intervals.icu still succeeds — it is
simply not connected.

Reading a stored token back never throws, including when the secret is missing
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
- **A platform never fails your write.** intervals.icu being down, or a grant
  having been revoked, is recorded against the connection and shown on the
  dashboard; creating the workout still succeeds. The bookkeeping is inside
  that guard too, not only the push: a link table that refuses a write is still
  no reason for a workout that is safely stored to come back as a 500.
- **Only what changed is pushed.** Each link holds a digest of the plan as it
  was last pushed, so a run over a calendar already in step costs one list and
  no pushes. `updated_at` cannot do that job — recording a completion read back
  off a platform bumps it, and the next sync would then push the unchanged plan
  straight back out over a change the platform itself reported.
- **A delete that missed is owed, not forgotten.** A workout deleted here while
  intervals.icu was unreachable is taken off the calendar by the next sync. The
  link row stays until the removal lands, because it is the only record of the
  event left to remove.
- **Our window is ours, not theirs.** A workout ageing out of the readable
  7/14-day window is not taken off your intervals.icu calendar.

## Targets arrive absolute, and are shown against your thresholds

The FIT file carries what you wrote: a pace as a speed in m/s, a power target
in watts, a heart rate in bpm. intervals.icu converts each one into a
percentage of the matching threshold on your athlete profile as it imports, and
shows the absolute figure alongside it. So a step planned at 4:35-5:00/km
displays as `120-131% Pace` against a 6:00/km threshold, and one at 145-152 bpm
as `83-87% LTHR`.

**If a target reads wrong, or shows as `null-null`, check your thresholds
first.** intervals.icu Settings holds a threshold pace per sport, an FTP, and a
threshold heart rate; without the one a target needs there is nothing to
convert against, and the step arrives with no usable target however correct the
file is. Nothing here can supply them — they are yours, and they are what every
percentage on that calendar is measured against.

One thing that conversion costs you is precision. A percentage is stored whole,
so the bpm intervals.icu shows is re-derived from a rounded percentage and can
sit a beat off what you planned. The file is right; the round trip is lossy.

## Completion arrives twice: a webhook, and an hourly backstop

intervals.icu delivers webhooks to OAuth applications it has approved, which is
now what this is. Registered on their app page against
`https://workouts-mcp.com/webhooks/intervals`, with one event ticked:

**`ACTIVITY_ANALYZED`.** Not `ACTIVITY_UPLOADED` — that fires on arrival,
*before* they have paired the activity with the event we pushed, and the
pairing is the only thing that says which workout was completed. The analysed
event also comes debounced by about a minute, so one upload is one delivery
rather than a burst.

The webhook is a **nudge, not evidence**. The only thing the body is believed
for is which athlete it concerns; what actually marks the workout done is the
pairing, read back over their API exactly as the polled path does it. So a
replayed or forged body cannot tick a session off by itself.

An hourly cron still reads the same pairings back for every connection, and
**Sync now** does it on demand. That is a backstop now rather than the main
path — a delivery that never arrives, because they gave up retrying or the
Worker was mid-deploy, would otherwise be lost for good. It is also the only
path for an activity that came from Strava: intervals.icu does not send activity
webhooks for those at all.

### Proving a webhook is theirs

Two shared secrets, both compared as digests so the work is fixed-length
whatever arrives:

| Where | Binding | Note |
| --- | --- | --- |
| `secret` in the JSON body | `INTERVALS_WEBHOOK_SECRET` | Theirs; required, or the endpoint is a 503 |
| `Authorization` header | `INTERVALS_WEBHOOK_AUTHORIZATION` | Yours; only checked when set |

The header value is whatever was typed into their app page and is compared
verbatim, `Bearer ` prefix included — there is no header *name* to configure,
only the value.

The endpoint sits at `/webhooks/intervals`, deliberately outside `/api/`, so it
never meets `withUser`: the caller is intervals.icu authenticating itself, not
an athlete presenting one of our credentials.

### What the status code means to them

A non-2xx is retried with exponential backoff, so it is used as a request to
come back rather than as a complaint:

- **2xx** for anything permanent, including an athlete nobody here has
  connected and an event type we do not act on. A retry would never do better.
- **502** when their API could not be read back. That one *is* worth retrying.
- **401** for a secret that does not match.

One athlete can be connected to more than one account here (see "Separate
accounts" in [auth.md](auth.md)), so an event fans out to every connection it
matches. One athlete's revoked token does not cost the others their
completions: each failure is recorded against its own connection, and the
delivery is only failed once they have all had a go.

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
revoked grant must not stop the sweep for anyone else.

**A failed push is not retried on a schedule.** It is recorded against the
connection and shown on the dashboard, and it clears when the athlete next
edits that workout or presses **Sync now**. Nothing sweeps for stuck
connections: the standing error is the report, and acting on it is a choice
rather than something that happens quietly overnight.

## intervals.icu API notes

Three things about their API shape `src/platforms/intervals.ts`:

- The athlete id in a path may be `0`, meaning "whoever the token belongs to",
  so nothing has to look an athlete up before writing.
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
