# Writing a workout

A workout is a date, a name, a sport and a list of steps. A step either **does
something** — a duration plus an optional target — or **repeats** a group of
steps.

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

Bare numbers in `goal_s` are always seconds, so `goal_s: 300` and
`goal_s: "5:00"` agree.

A step with **no** duration runs until the lap button is pressed — which is
what you usually want for a cooldown.

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

A step may carry **two** targets, as long as they constrain different things —
FIT stores a primary and a secondary, and a watch shows both:

```jsonc
{ "goal_meters": 400, "target_pace_km": ["4:00", "4:15"], "target_cadence": [178, 184] }
```

Which one leads is decided by a fixed order — **pace, power, heart rate,
cadence** — so the thing you are told to run is the primary and what follows
from it is the secondary. Writing the fields in the other order changes
nothing. Two targets on the *same* metric (`target_heart_rate` and
`target_hr_zone`, say) is an error rather than a silent winner, and a third
target is refused because FIT has nowhere to put it.

## Ranges

Every target takes a range as `[floor, ceiling]`, and either end may be `"-"`
to leave it open. `""`, `"*"`, `"any"`, `"none"` and `null` read the same way.
A single value sets both ends.

```jsonc
"target_heart_rate": [140, 155]     // between 140 and 155 bpm
"target_heart_rate": [140, "-"]     // above 140
"target_heart_rate": ["-", 155]     // below 155
```

Pace reads the same way — first entry is the floor on effort — but because a
*lower* pace number is *faster*, that comes out as:

```jsonc
"target_pace_km": ["6:30", "-"]     // faster than 6:30/km
"target_pace_km": ["-", "8:00"]     // slower than 8:00/km
"target_pace_km": ["4:00", "4:15"]  // a 4:00-4:15/km band
```

A two-sided pace band is unambiguous whichever way round you write it, so
`["4:15", "4:00"]` means the same thing.

Both ends of a range must use the same unit. FIT stores a percentage and an
absolute in the same field, telling them apart by magnitude, so mixing them
would be read as two unrelated numbers rather than as two ends of one band.

An open end is encoded as an *absent* field, not as a stand-in value: FIT has
no value that reads as "no limit", and a 0 floor on a power range is read as 0%
of FTP rather than as "no floor".

## Zones

A single zone is stored as a zone, and the watch resolves it against whatever
you have configured:

```jsonc
"target_hr_zone": 2        // whatever your watch calls zone 2
```

FIT has no way to say "zones 2 to 3", so a **range** is converted to a
percentage band instead. The endpoints are boundaries on a continuous scale,
which makes fractional zones work but means the numbers read differently from
how a coach says them:

```jsonc
"target_hr_zone": ["2", "3"]     // exactly zone 2 — 60-70% of max HR
"target_hr_zone": ["2", "4"]     // all of zones 2 and 3 — 60-80%
"target_hr_zone": ["2.5", "3"]   // the top half of zone 2 — 65-70%
"target_hr_zone": ["3", "-"]     // zone 3 and above
```

The conversion needs a zone model, since your watch's own boundaries are not
something this server knows. Heart rate uses Garmin's default five zones as a
share of max HR (50/60/70/80/90/100); power uses the standard seven-zone model
as a share of FTP (1/55/75/90/105/120/150/200). If your zones differ, give
explicit numbers with `target_heart_rate` or `target_watts` instead.

`target_pace_zone` takes a single zone only: FIT has no percentage speed
target, so there is nothing sensible to convert a range into. Use
`target_pace_km` with explicit paces for a band.

## The workout itself

| Field | Meaning |
| --- | --- |
| `date` | Required, `YYYY-MM-DD` |
| `name` | Defaults to the sport and date |
| `sport` | `running`, `cycling`, `swimming`, `walking`, `hiking`, `rowing`, `training`, `generic` |
| `sub_sport` | How it is done: `treadmill`, `track`, `trail`, `road`, `indoor_cycling`, `lap_swimming`, … |
| `notes` | Description of the session, written into the FIT file so the watch shows it |
| `tags` | Free-form labels — see below |
| `external_id` | Your own key — see below |
| `completed_at` | Read-only here; set through the completion routes |

`sub_sport` is worth setting: a watch picks its activity profile from it, so a
treadmill session will not sit waiting for a GPS fix.

`tags` are labels you choose — `["key"]`, `["quality", "long run"]` — up to ten
of thirty characters each. Nothing here reads them; what they are for is the
calendar at the other end, where a connected platform shows and filters on them,
so the week's key session is one you can pick out there. On intervals.icu they
land as the event's own tags. They are trimmed and de-duplicated
case-insensitively, keeping the first spelling, and sending the field replaces
the whole list — `"tags": []` clears it.

`external_id` makes re-syncing safe. Create a workout again with the same key
and it **updates that workout in place** — same id, moved if the date changed —
instead of adding a duplicate and quietly pushing an older session past the
per-user cap. Keys are scoped to one athlete, so two people may use the same
one.

A write — create or update — answers with which workout it was and where to
find it: id, date, name, sport and the two URLs. It does not echo the steps
back at the caller who just sent them. Reads return the whole thing.

## Marking one done

A workout carries `completed_at`, an ISO instant, once the session has actually
been done; until then the field is simply absent. It is set by its own verb
rather than by rewriting the plan:

```
complete_workout { "date": "2026-09-12", "id": "a1b2c3d4" }
complete_workout { "date": "2026-09-12", "id": "a1b2c3d4", "completed_at": "2026-09-12T06:30:00Z" }
complete_workout { "date": "2026-09-12", "id": "a1b2c3d4", "completed": false }
```

Without a `completed_at` it is now, which is the common case — an athlete
marking a session done as they finish it. Pass one to log a session after the
fact; a bare `YYYY-MM-DD` is read as the start of that day. `completed: false`
clears the record and puts the workout back to merely planned; naming a time
alongside it is refused rather than guessed at. Over REST that is `POST` and
`DELETE` on `/api/workouts/:date/:id/complete`, and on the dashboard it is the
date field on the workout card.

Because it is its own verb, rewriting the plan does not un-do the session:
`update_workout`, a `PUT`, and a re-sync under the same `external_id` all carry
the record across, including when the workout moves to another day.

Every read also carries `planned`, computed from the steps with repeats
resolved:

```jsonc
"planned": { "seconds": 2520, "meters": 3200, "steps": 18, "open_steps": 0 }
```

`open_steps` counts steps that run until a lap press. When it is above zero the
totals are a floor rather than the whole session.

## What gets stored

Steps are kept in exactly the shape you send them, and reads give them back
that way — `goal_s`, `target_pace_km`, an optional `intensity`. What you POST
is what you GET.

FIT's own model, with one duration per step and speeds in metres per second, is
derived in `src/resolve.ts` when a file is generated. It is an encoding detail,
so it stays out of the database and out of responses. The steps column is
queryable as ordinary JSON with the field names you wrote:

```sql
SELECT json_extract(steps, '$[1].repeat') FROM workouts WHERE user_id = ?;
```

The only thing normalized on the way in is spelling: `goal_time` is stored as
`goal_s`, and `{"type":"repeat","times":3}` as `{"repeat":3}`, so one thing
does not round-trip two ways.

## The rest

`intensity` is one of `warmup`, `active`, `interval`, `rest`, `recovery`,
`cooldown`. Leave it out and it is guessed from the step name, defaulting to
`interval` inside a repeat and `active` elsewhere.

Repeats may nest up to three deep, and a workout may hold 200 steps in total.
Anything the server cannot make sense of comes back as an error naming the
exact field, e.g. `steps[1].steps[0].target_pace_km[0]: "nope" is not a valid
duration`.

Validation is done by resolving. `src/workout.ts` checks the *shape* of a step
— its keys, its name, its nesting — and `src/resolve.ts` checks the *values*,
by building the model the FIT encoder wants and throwing the result away. One
set of rules rather than two.
