# What the athlete actually did

A plan goes out as a FIT file; the session comes back as one. This is the half
that reads it. When intervals.icu says a recording has been analysed and paired
with a workout we pushed, the file is fetched once, reduced to a page of
numbers, and stored against that workout. `get_workout_stats` hands them back.

The point is that a weekly review costs nothing. Before this, an assistant
asked for [the archive](recordings.md), downloaded a ZIP of FIT files and
parsed `lap` and `session` messages itself — slow, and impossible outright when
the file cannot be served at all (`422: Cannot read Strava activities via the
API`). The archive is still there, and still the right answer when a question
goes deeper than these numbers.

## What is stored

```json
{
  "platform": "intervals", "activity_id": "i44031892",
  "computed_at": "2026-09-07T07:31:02.000Z",
  "session": { "sport": "running", "elapsed_s": 3612, "avg_hr": 148, "…": "…" },
  "laps": [
    {
      "index": 1, "role": "work", "rep_number": 1,
      "planned_step_index": 1, "planned_step_name": "Threshold",
      "match_confidence": "high",
      "duration_s": 300, "avg_hr": 162, "min_hr": 151, "avg_pace_s_km": 245,
      "elev_net_m": 9, "avg_grade_pct": 0.4,
      "quarters": { "split_by": "time", "hr": [151, 160, 166, 169], "pace_s_km": [243, 244, 246, 247], "power_w": null, "cadence": [172, 174, 174, 175], "elev_net_m": [1, 2, 9, -3], "grade_pct": [0.2, 0.3, 1.4, -0.5] },
      "target": { "metric": "pace_s_km", "low": 240, "high": 255, "pct_time_in_band": 0.86, "pct_time_above": 0.14, "pct_time_below": 0 },
      "flags": []
    }
  ],
  "flags": []
}
```

One lap per segment of the recording — a work interval, a recovery, a warmup —
in the order they were run, and never dropped for being short, odd or
unmatched. The session totals are also on the workout itself, which is why
`get_workout` carries `stats` without the laps: a listing of three weeks would
otherwise be mostly laps, and an assistant reading one wants to know which
session to ask about, not how the fourth quarter of its third rep went.

**What is deliberately not stored: the record stream.** No second-by-second
heart rate, no GPS track, no altitude profile. What is kept is a summary and,
per lap, four numbers per metric. The reduction happens in the Worker and the
file is thrown away; nothing here ever holds a trace of where anybody ran.

There are no verdicts either — no zones, no "in band" booleans, no training
load. A boolean hides the difference between sitting at the floor of a band and
sitting mid-band, which is usually the actual finding. The numbers and the
target go back; the reader draws the conclusion.

## Laps against the plan

The mapping is the most valuable field here, because this server knows both the
plan and the recording and an assistant reading lap order alone does not.

Laps are paired with the flattened plan — repeats expanded, so a 3x(4 min, 90 s
jog) is six steps — **in order, with both ends free to move**, because the ends
are where a real session differs from the plan:

- **Stopped early.** Aborted after the second rep, or the cooldown skipped: the
  laps that were run are matched, and the steps that were not simply have no
  lap. Reading the stats beside the plan says which.
- **Carried on past the end.** A cooldown extended, or a jog home after it: the
  extra laps fold into the step they overran, so two laps can name the same
  `planned_step_index`.
- **Run to the wrong length.** A cooldown cut short, a rep abandoned: paired as
  written, with `match_confidence` saying it did not line up.
- **Started before the session did.** A lap or two pressed on the start line:
  the pairing is tried at a small offset as well, and those laps belong to no
  step. An offset claims part of the recording is junk, so it takes more
  evidence than the plain reading to win.

Neither end is a reason to withhold the reps in the middle, which are the part
anybody is actually asking about.

| `match_confidence` | |
| --- | --- |
| `high` | The lap ran to roughly the step's duration or distance |
| `low` | Mapped on order, but off its step's length by more than half |
| `unmatched` | No mapping was made |

**Two bars, not one.** Whether to map at all is decided on a tight reading — a quarter
of a time step, a tenth of a distance step — because that is the guard against a
mapping that has drifted, and only a strict reading catches one. How *well* a mapping
made lines up is reported on a loose one, half the step's own length, because `low` is
meant for genuine ambiguity: a cooldown run 844 m of a planned kilometre is the
ordinary shape of a session ending, and a field that fires on that gets ignored.

What *is* withheld is a mapping that has **drifted**. A lap press missed halfway
through a session puts every lap after it against the wrong step, and that is
the one failure worth refusing: it reads as a confident, wrong verdict and
nothing downstream can tell. So the pairing is accepted on the weight of the
evidence — most pairs have to be roughly the length they were written — rather
than on the counts agreeing. When it is not, every lap comes back `unmatched`
with a `laps_do_not_match_plan` flag on the session, and the numbers are all
still there.

### The one lap past the end is held out of the weighing

A recording often has one lap more than the plan has steps, and it is one of two
things. A watch closes a file with a scrap — four seconds, a handful of records
— when the athlete presses stop. Or the athlete kept going: a jog home, a few
more minutes spinning, real work the plan simply does not cover.

Neither is a step, and left in the evidence neither merely fails to match: it is
counted as a pair that failed, and the fewer steps a session has the more of the
vote it is. A one-step ride recorded as one 40-minute lap and one 4-second lap
was exactly half of it, which is enough to lose a strict majority, so a ride
executed perfectly came back entirely unmatched.

So a lap the plan has no step for is held out before anything is weighed — held
out of the *weighing*, not out of the session. Every lap the plan does have a
step for still matches as it would have, which is the point: the reps in the
middle are what anybody is asking about.

| The tail lap | What it is | How it reads |
| --- | --- | --- |
| under a minute | the file closing | `unmatched`, with `short_lap` |
| a minute or more | training past the end of the plan | `unmatched`, with `extra_lap` |
| under a minute, and the length of the last step | strides — that step again | matched, like any other lap |

Only a lap the plan has no step left for can be either. A session that ends
short of its plan ends on a *real* step run badly — 120 m of a planned kilometre
— and that lap is the cooldown however little of it was done; refusing it would
throw away the thing the loose bar above exists to report.

An extra lap is left `unmatched` rather than folded into the last step, which is
what this used to do. Eight minutes jogging home is not the five-minute cooldown
run long, and reporting it as that step at `low` confidence made a claim about
execution out of what is really a lap with nowhere to go. It keeps its
measurements and its quarters — it is real training — and says what it is.

`role` comes from the planned step where there is one (`warmup`, `work`,
`recovery`, `cooldown`) and from the lap's own FIT `intensity` where there is
not.

## Quarters

Every lap over 60 seconds is split into four equal segments, each metric
averaged within its segment. This is what makes the averages trustworthy: a
5-minute rep that starts at 6:00/km and decays to 6:40 averages 6:20 and reads
as a clean hit against a 6:10-6:20 band. The quarters expose it. Decoupling,
fade within a rep and heart-rate drift all fall out of them, so none of those
needs a field of its own.

- **Split by what the step was prescribed in.** A step written as `5 min`
  splits into four equal slices of moving time; one written as `800m` splits by
  distance. `split_by` says which.
- **Under 60 seconds, `quarters` is null** and the lap is flagged `short_lap`.
  Quartering a 20-second stride measures noise. Its averages are still there.
- **Pauses are excluded.** The gap back to the previous record is what a sample
  is weighted by, and a gap far longer than the others counts as a stop rather
  than a slow sample. Far longer is measured against this recording's own
  cadence, not a fixed number of seconds: a watch on smart recording writes a
  sample every ten or fifteen, and reading each of those as a stop would leave
  every lap with no moving time and no quarters at all.
- **Nothing is smoothed, interpolated or corrected.** Heart rate is expected to
  be low in the first quarter of a hard rep because it is still rising. That
  ramp is signal.
- **The ground comes with them.** `elev_net_m` is where a quarter finished
  against where it started, and `grade_pct` is that over the distance covered.
  A quarter slower than the one before it very often means the hill it was run
  up, and quarters read without the terrain say *fade* — confidently, and
  wrongly. `elev_net_m` is one subtraction, so unlike a summed gain it carries
  the sensor's noise on its two ends and nowhere else.

The lap carries the same pair: `elev_net_m` and `avg_grade_pct`, the file's own
`avg_grade` where it gave one.

## Filled in from the stream

A summary message is meant to carry the session's own extremes and its power
figures, and a file built out of *streams* rather than written by a head unit
often does not: intervals.icu's generated FIT comes back with no normalized
power, no work, no maximum power and no minimum heart rate at all. Those are
computed here instead, from the records already in hand, and only where the
file was silent — the device's own figure wins wherever it gave one.

- **`normalized_power_w`**, per session and per lap. Coggan's method: a rolling
  30-second average, raised to the fourth, averaged, rooted back. Computed per
  sample rather than per second, because a watch on smart recording has no
  per-second to compute over, and refused outright for anything shorter than
  the window itself, where it would be a number nobody could read.
  `variability_index` follows from it.
- **`work_kj`**, power over the moving seconds each sample stands for.
- **`max_power_w`, `max_hr`, `min_hr`**, per session and per lap. `min_hr` on a
  recovery lap is the whole reason the field exists.

- **`elev_gain_m` and `elev_loss_m`**, per session and per lap — but never by
  summing an unsmoothed trace, which turns barometric drift into hundreds of
  metres of climbing. A move is counted only once it clears **3 metres** from
  wherever the last one was counted from, which is where the platforms that do
  this settle. Twenty minutes of a sensor wobbling a metre either way
  accumulates into nothing, which is the point.

## Targets

Where the mapped step carried a target this server can measure, the lap gets
the band and how much of it was spent inside, above and below — by moving time,
over the whole record stream rather than off the quarters.

Only absolute targets: heart rate in bpm, pace, watts, cadence. A zone, or a
percentage of a threshold, is a number only the athlete's platform profile
holds — intervals.icu converts those on import, and we never read them back —
so no target is emitted rather than one with invented bounds. Both ends have to
be given; a half-open target is left off for the same reason.

Pace bounds are **seconds per kilometre, so `low` is the faster end**. A
`4:00-4:15/km` step is `low: 240, high: 255`.

## What is not there at all

`intensity_factor` was specified and is gone. It is normalized power over the
athlete's threshold, and the threshold is on their platform profile: the file
carries no `threshold_power` and no user profile, so the field was null on
every session ever read. A field that can never be filled is worse than an
absent one — it reads as "not recorded today" rather than "not knowable here".
`normalized_power_w` is in the payload, and the athlete's FTP is in the zones
document a consumer reads before it analyses anything.

Everything else that comes back null is *conditionally* null and says something
by it: `distance_m` and `avg_pace_s_km` on an indoor ride, the elevation fields
where no altitude was recorded, `normalized_power_w` on a lap shorter than its
window.

## Units and nulls

- Pace is an integer, seconds per kilometre — `377`, never `"6:17"`.
- Heart rate, power and cadence are integers; distance is metres; durations are
  seconds.
- **Missing data is `null`, never `0`.** A zero heart rate on a lap run without
  a strap silently corrupts every average computed downstream, and this is the
  single most damaging thing the implementation could get wrong. A `0` average
  in the file is read as "not recorded" for exactly that reason.
- Cadence is doubled for running, walking and hiking. FIT counts one leg per
  cycle; an athlete counts both, and a target written as `180` means steps.

## Quality flags

As important as the numbers: they say when a figure should be distrusted rather
than reported as fact. On the session:

| | |
| --- | --- |
| `no_hr` | No heart rate anywhere in the recording |
| `hr_dropout` | Over a tenth of the samples have none — optical sensors do this |
| `gps_dropout` | Position was recorded, but not throughout |
| `long_pause` | A gap of over two minutes between records |
| `autopause_active` | Moving time is materially under elapsed |
| `laps_do_not_match_plan` | The mapping was withheld; see above |
| `source_unreadable` | The file could not be fetched or read; there is nothing else here |

And on a lap: `short_lap`, where quarters were suppressed, and `extra_lap`, where
the lap is past the end of the plan and matched to no step.

## When it runs, and once

The webhook is the path: `ACTIVITY_ANALYZED` arrives within a minute of a
session being analysed, the completion is applied, and the recording behind it
is read in the same pass. The hourly poll is the backstop for a delivery that
never arrived, exactly as it is for completions.

What says a session has already been read is the stored stats themselves, not a
ledger — so a workout whose plan was rewritten, or one recorded before this
existed, is picked up by the next pass rather than being stuck.

A recording that could not be read is stored as *saying* that, with the reason
and the attempt it was. It is tried **three times**, and never twice inside
half an hour — three webhook deliveries in a minute are one outage, not three
tries at it — and then the failure stands. A platform having a bad afternoon is
not the same as a session with no file to fetch, and without the count the
hourly pass would go back for an unservable file every hour for a week.

One already read is left alone, **unless the platform now names a different
activity** for the same session: an upload deleted and done again is not the
session the stored numbers describe, so it is read afresh.

`syncNow` — the dashboard's **Sync now**, and the redirect at the end of
connecting a platform — reads no recordings at all. Somebody is waiting on
those, and a recording is a download and a FIT decode. The webhook reads them
as they arrive and the hourly pass catches up on the rest.

Two limits keep one invocation inside a Worker's budget. At most **five**
recordings are read per webhook or scheduled run — shared across every athlete
it visits, not five each, because the hourly pass takes a batch of forty — and
the body is refused once it passes **8 MiB** rather than being buffered whole.
A backlog is worked off over the passes behind it.

## Where it sits

```
src/stats.ts              the decode, the mapping, the quarters, the flags
src/platforms/index.ts    `readStats`, called where a completion is applied
migrations/0010_…         the `stats` column on `workouts`
```

The dashboard shows it too, under a completed workout: the session totals, and
a lap-by-lap table of what each one was aimed at and what it actually did. It
reads `GET /api/workouts/:date/:id/stats` when the card is opened, and the
table appears only where the laps were matched — an unmatched recording gets
its totals and the flag saying why, rather than a row per lap with nothing to
compare it to.

It is a column on the workout, so it ages out with the retention window, is
carried when a workout moves day, and goes when the workout is deleted. The
platform sync is the only writer, and a caller cannot set it.

**A plan is frozen once a session has been recorded against it.** The mapping
names steps by position, so rewriting the steps underneath it leaves a
confident answer about a step that never ran. Everything else about the workout
still moves — its name, its notes, its tags, the day it sits on — and a plan
that really does need changing is changed by marking the session not done
first, which is the honest order: it was not this workout after all. A workout
un-completed that way keeps its laps only while its steps are untouched; change
them and the mapping goes, and the next pass reads the recording again against
the plan as it now stands.

**Reading a workout does not read its laps.** Every query but one takes the
column through SQLite's `json_remove(stats, '$.laps')`, so what a `Workout`
carries is the totals and nothing else; `db.getStats` is the one read that
asks for the whole document, and `get_workout_stats` is the only thing that
calls it. Listing three weeks of training would otherwise parse a page of laps
per workout to throw all of them away.

**And the words alongside them.** `get_workout_stats` answers with the
workout's `comment` beside the figures — the athlete's own note on how the
session went, synced with the recorded activity on their platform. A lap that
fell out of its band because they cut the session short reads very differently
once that is on the page, so the note travels with the numbers rather than
waiting to be asked for separately. See
["Saying how it went"](workouts.md#saying-how-it-went).
