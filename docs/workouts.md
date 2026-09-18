# Writing a workout

A workout is a date, a name, a sport and a list of steps. A step either **does something**
— a duration plus an optional target — or **repeats** a group of steps.

```json
{
  "date": "2026-09-12",
  "name": "8x400m",
  "sport": "running",
  "sub_sport": "track",
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

## Durations — at most one per step

| Field | Meaning |
| --- | --- |
| `goal_s` | Seconds, or `"mm:ss"` / `"hh:mm:ss"` |
| `goal_meters`, `goal_km`, `goal_miles`, `goal_yards` | Distance |

Bare numbers in `goal_s` are always seconds. A step with **no** duration runs until the lap
button is pressed — usually what you want for a cooldown.

## Targets — up to two per step

| Field | Accepts |
| --- | --- |
| `target_pace_km`, `target_pace_miles` | `"mm:ss"` paces |
| `target_heart_rate` | bpm, or `"85%"` of max HR |
| `target_watts` | watts, or `"95%"` of FTP |
| `target_cadence` | rpm |
| `target_hr_zone` | zone 1-5, or a range of boundaries |
| `target_power_zone` | zone 1-7, or a range of boundaries |
| `target_pace_zone` | zone 1-10, single only |

A step may carry **two**, as long as they constrain different things — FIT stores a primary
and a secondary, and a watch shows both:

```jsonc
{ "goal_meters": 400, "target_pace_km": ["4:00", "4:15"], "target_cadence": [178, 184] }
```

Which leads is decided by a fixed order — **pace, power, heart rate, cadence** — so the
thing you are told to run is the primary. Writing the fields the other way round changes
nothing. Two targets on the *same* metric is an error rather than a silent winner, and a
third is refused because FIT has nowhere to put it.

## Ranges

Every target takes `[floor, ceiling]`, and either end may be `"-"` to leave it open (`""`,
`"*"`, `"any"`, `"none"` and `null` read the same way). A single value sets both ends.

```jsonc
"target_heart_rate": [140, 155]     // between 140 and 155 bpm
"target_heart_rate": [140, "-"]     // above 140
"target_pace_km": ["6:30", "-"]     // faster than 6:30/km — the floor is on effort
"target_pace_km": ["-", "8:00"]     // slower than 8:00/km
```

Pace reads the same way — first entry is the floor on effort — but because a *lower* pace
number is *faster*, a two-sided pace band is unambiguous whichever way round you write it.

Both ends must use the same unit: FIT stores a percentage and an absolute in the same
field, telling them apart by magnitude, so mixing them would read as two unrelated numbers.
An open end is encoded as an *absent* field, not a stand-in — a 0 floor on a power range
reads as 0% of FTP rather than as "no floor".

## Zones

A single zone is stored as a zone and the watch resolves it. FIT has no way to say "zones 2
to 3", so a **range** becomes a percentage band, with the endpoints read as boundaries on a
continuous scale — which makes fractional zones work but reads differently from how a coach
says them:

```jsonc
"target_hr_zone": 2              // whatever your watch calls zone 2
"target_hr_zone": ["2", "3"]     // exactly zone 2 — 60-70% of max HR
"target_hr_zone": ["2", "4"]     // all of zones 2 and 3 — 60-80%
"target_hr_zone": ["2.5", "3"]   // the top half of zone 2 — 65-70%
```

The conversion needs a zone model, since your watch's own boundaries are not something this
server knows: heart rate uses Garmin's default five zones as a share of max HR
(50/60/70/80/90/100), power the standard seven as a share of FTP
(1/55/75/90/105/120/150/200). If your zones differ, give explicit numbers instead.

`target_pace_zone` takes a single zone only — FIT has no percentage speed target, so there
is nothing to convert a range into.

## The workout itself

| Field | Meaning |
| --- | --- |
| `date` | Required, `YYYY-MM-DD` |
| `name` | Defaults to the sport and date |
| `sport` | `running`, `cycling`, `swimming`, `walking`, `hiking`, `rowing`, `training`, `generic` |
| `sub_sport` | How it is done: `treadmill`, `track`, `trail`, `road`, `indoor_cycling`, … |
| `notes` | Description of the session, written into the FIT file so the watch shows it |
| `tags` | Free-form labels, up to ten of thirty characters |
| `external_id` | Your own key |
| `completed_at` | Read-only here; set through the completion routes |
| `stats` | Read-only: the session recorded against it, totals only. See [stats.md](stats.md) |

`sub_sport` is worth setting: a watch picks its activity profile from it, so a treadmill
session will not sit waiting for a GPS fix.

`notes` is validated to 1000 characters, but a FIT string field holds 254 bytes and the file
carries the start of anything longer (see [fit.md](fit.md)); the whole note is kept here.

`tags` are for the calendar at the other end — nothing here reads them. They are trimmed and
de-duplicated case-insensitively, and sending the field replaces the whole list.

`external_id` makes re-syncing safe: creating a workout again with the same key **updates
that workout in place**, same id, moved if the date changed. Keys are scoped to one athlete.

An id is unique to an athlete, not to a day, so it names the same workout wherever it
sits. Every call that takes a `date` beside an `id` — a tool argument or a path segment —
ignores the date and resolves by the id; see [api.md](api.md#the-date-in-a-path-is-ignored).

A write answers with which workout it was and where to find it, not with the steps the
caller just sent.

## Marking one done

`completed_at` is an ISO instant, absent until the session has been done, and set by its
own verb rather than by rewriting the plan:

```
complete_workout { "date": "2026-09-12", "id": "a1b2c3d4" }
complete_workout { "date": "2026-09-12", "id": "a1b2c3d4", "completed_at": "2026-09-12T06:30:00Z" }
complete_workout { "date": "2026-09-12", "id": "a1b2c3d4", "completed": false }
```

Without a `completed_at` it is now. A bare `YYYY-MM-DD` is read as the start of that day.
`completed: false` clears the record; naming a time alongside it is refused rather than
guessed at. Over REST that is `POST` and `DELETE` on `/api/workouts/:date/:id/complete`.
The dashboard has no control for it.

Because it is its own verb, rewriting the plan does not un-do the session: `update_workout`,
a `PUT`, and a re-sync under the same `external_id` all carry the record across, including
onto another day, and the stats come with it.

## Moving one to another day

The day is its own verb too, because a plan that only slips a day should not have to be
resent:

```
reschedule_workout { "date": "2026-09-12", "id": "a1b2c3d4", "to_date": "2026-09-14" }
```

The row does not move — one column changes — so the id, the steps, the completion, the
note and the stats all stay as they are. That makes this the one way to move a session
already done, whose steps a rewrite may not touch. Over REST it is
`PUT /api/workouts/:date/:id/date` with `{"date": "2026-09-14"}`; a day outside the
retention window is refused rather than written where it could not be read back.

## Saying how it went

`comment` is the athlete's own note on the session, in their words. Not `notes` — those are
the plan's brief and go out to the watch *before* — and not a summary an assistant wrote.

```
comment_workout { "date": "2026-09-12", "id": "a1b2c3d4", "comment": "Legs flat from Sunday. Cut the last two reps." }
comment_workout { "date": "2026-09-12", "id": "a1b2c3d4", "comment": "" }
```

Its own verb, for the same reason completing has one, and it carries across the same
writes. An empty comment clears it. Over REST that is `PUT` and `DELETE` on
`/api/workouts/:date/:id/comment`. It comes back on `get_workout`, `list_workouts` and
`get_workout_stats`, so a review has the words beside the figures.

**It is pushed to the connected training platform**, and nothing is read back the other way
— see [integrations.md](integrations.md#the-comment-goes-out-and-never-comes-back).

**The steps stop being editable once it is done**, and a write that changes them is
refused: the stats name the planned step each recorded lap was, by position, so rewriting
them leaves a confident answer about a step that never ran. Everything else still moves —
name, notes, tags, day. To change the plan, mark the session not done first.

Every read carries `planned`, computed from the steps with repeats resolved:

```jsonc
"planned": { "seconds": 2520, "meters": 3200, "steps": 18, "open_steps": 0 }
```

`open_steps` counts steps that run until a lap press; above zero, the totals are a floor.

## What gets stored

Steps are kept in exactly the shape you send them and read back that way — what you POST is
what you GET — so the column is queryable as ordinary JSON with the field names you wrote:

```sql
SELECT json_extract(steps, '$[1].repeat') FROM workouts WHERE user_id = ?;
```

FIT's own model, with one duration per step and speeds in m/s, is derived in
`src/resolve.ts` when a file is generated; it is an encoding detail, so it stays out of the
database and out of responses. The only thing normalized on the way in is spelling:
`goal_time` is stored as `goal_s`, `{"type":"repeat","times":3}` as `{"repeat":3}`.

## The rest

`intensity` is one of `warmup`, `active`, `interval`, `rest`, `recovery`, `cooldown`. Leave
it out and it is guessed from the step name, defaulting to `interval` inside a repeat and
`active` elsewhere.

Repeats may nest up to three deep, and a workout may hold 200 steps. Anything the server
cannot make sense of comes back naming the exact field, e.g.
`steps[1].steps[0].target_pace_km[0]: "nope" is not a valid duration`.

**Validation is done by resolving.** `src/workout.ts` checks the *shape* of a step — its
keys, its name, its nesting — and `src/resolve.ts` checks the *values*, by building the
model the FIT encoder wants and throwing the result away. One set of rules rather than two.
