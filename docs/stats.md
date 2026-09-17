# What the athlete actually did

A plan goes out as a FIT file; the session comes back as one. When a platform says a
recording has been analysed and paired with a workout we pushed, the file is fetched once,
reduced to a page of numbers, and stored against that workout. `get_workout_stats` hands
them back, so a weekly review costs nothing. [The archive](recordings.md) answers what these
numbers cannot.

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

One lap per segment of the recording, in the order they were run, never dropped for being
short, odd or unmatched.

**The record stream is deliberately not stored** — no second-by-second heart rate, no GPS
track, no altitude profile. The reduction happens in the Worker and the file is thrown away,
so nothing here holds a trace of where anybody ran. **There are no verdicts either**: a
boolean hides the difference between sitting at the floor of a band and sitting mid-band,
which is usually the actual finding.

## Laps against the plan

The mapping is the most valuable field here: this server knows both the plan and the
recording, and an assistant reading lap order alone does not.

Laps are paired with the flattened plan **in order, with both ends free to move**, because
the ends are where a real session differs from the plan — stopped early, carried on past the
end, a step run to the wrong length, or a lap or two pressed before the start. Neither end
is a reason to withhold the reps in the middle.

| `match_confidence` | |
| --- | --- |
| `high` | The lap ran to roughly the step's duration or distance |
| `low` | Mapped on order, but off its step's length by more than half |
| `unmatched` | No mapping was made |

**Two bars, not one.** *Whether* to map at all is decided on a tight reading — a quarter
of a time step, a tenth of a distance step — because only a strict reading catches a
mapping that has drifted. *How well* it lines up is reported on a loose one, half the
step's length: a cooldown run 844 m of a planned kilometre is the ordinary shape of a
session ending, and a field that fires on that gets ignored.

A mapping that has **drifted** is withheld entirely — a missed lap press puts every lap
after it against the wrong step, which reads as a confident, wrong verdict nothing
downstream can catch. So the pairing is accepted on the weight of the evidence rather than
on counts agreeing; when it is not, every lap comes back `unmatched` with a
`laps_do_not_match_plan` flag and the numbers are all still there.

**One lap past the end is held out of the weighing.** A watch often closes a file with a
four-second scrap, or the athlete keeps going, and left in the evidence that counts as a
pair that failed: a one-step ride recorded as one 40-minute lap and one 4-second lap was
half the vote, so a perfect ride came back entirely unmatched. Held out of the *weighing*,
not out of the session:

| The tail lap | What it is | How it reads |
| --- | --- | --- |
| under a minute | the file closing | `unmatched`, with `short_lap` |
| a minute or more | training past the end of the plan | `unmatched`, with `extra_lap` |
| under a minute, and the length of the last step | strides — that step again | matched |

Only a lap the plan has no step left for can be either; a session that ends short ends on
a *real* step run badly. An extra lap stays `unmatched` rather than folding into the last
step — eight minutes jogging home is not a five-minute cooldown run long — and keeps its
measurements and quarters.

`role` comes from the planned step where there is one, and from the lap's own FIT
`intensity` where there is not.

## Quarters

Every lap over 60 seconds is split into four equal segments, each metric averaged within
its segment. This is what makes the averages trustworthy: a 5-minute rep that starts at
6:00/km and decays to 6:40 averages 6:20 and reads as a clean hit against a 6:10-6:20 band.
Decoupling, fade within a rep and heart-rate drift all fall out of the quarters, so none of
them needs a field.

- **Split by what the step was prescribed in** — `5 min` by moving time, `800m` by distance.
  `split_by` says which.
- **Under 60 seconds, `quarters` is null** and the lap is flagged `short_lap`: quartering a
  20-second stride measures noise.
- **Pauses are excluded.** A sample is weighted by the gap back to the previous record, and
  a gap far longer than the others counts as a stop — measured against this recording's own
  cadence rather than a fixed number of seconds, since smart recording writes a sample every
  ten or fifteen.
- **Nothing is smoothed, interpolated or corrected.** Heart rate is expected to be low in
  the first quarter of a hard rep because it is still rising. That ramp is signal.
- **The ground comes with them.** `elev_net_m` is where a quarter finished against where it
  started, `grade_pct` that over the distance covered — quarters read without the terrain say
  *fade*, confidently and wrongly. The lap carries the same pair, with the file's own
  `avg_grade` where it gave one.

## Filled in from the stream

A file built out of *streams* rather than written by a head unit often carries no normalized
power, no work, no maximum power and no minimum heart rate. Those are computed here from the
records in hand, and only where the file was silent — the device's own figure always wins.

- **`normalized_power_w`**: Coggan's method, a rolling 30-second average raised to the
  fourth, averaged, rooted back. Computed per sample rather than per second, because smart
  recording has no per-second to compute over, and refused below the window itself.
  `variability_index` follows from it.
- **`work_kj`**, power over the moving seconds each sample stands for.
- **`max_power_w`, `max_hr`, `min_hr`**. `min_hr` on a recovery lap is why the field exists.
- **`elev_gain_m` and `elev_loss_m`** — never by summing an unsmoothed trace, which turns
  barometric drift into hundreds of metres of climbing. A move counts only once it clears
  **3 metres** from wherever the last one was counted from.

## Targets

Where the mapped step carried a target this server can measure, the lap gets the band and
how much of it was spent inside, above and below — by moving time, over the whole record
stream rather than off the quarters.

Only absolute targets: heart rate in bpm, pace, watts, cadence. A zone or a percentage of a
threshold is a number only the athlete's platform profile holds, so no target is emitted
rather than one with invented bounds. Both ends have to be given.

Pace bounds are **seconds per kilometre, so `low` is the faster end**: `4:00-4:15/km` is
`low: 240, high: 255`.

`intensity_factor` was specified and is gone: it needs a threshold the file does not carry,
so it was null on every session ever read, and a field that can never be filled reads as
"not recorded today" rather than "not knowable here". Everything else that comes back null
is *conditionally* null and says something by it.

## Units and nulls

- Pace is an integer, seconds per kilometre — `377`, never `"6:17"`.
- Heart rate, power and cadence are integers; distance is metres; durations are seconds.
- **Missing data is `null`, never `0`.** A zero heart rate on a lap run without a strap
  silently corrupts every average computed downstream, and this is the single most damaging
  thing the implementation could get wrong. A `0` average in the file is read as "not
  recorded" for that reason.
- Cadence is doubled for running, walking and hiking: FIT counts one leg per cycle, an
  athlete counts both.

## Quality flags

They say when a figure should be distrusted rather than reported as fact. On the session:
`no_hr`, `hr_dropout` (over a tenth of samples), `gps_dropout`, `long_pause` (over two
minutes), `autopause_active`, `laps_do_not_match_plan`, and `source_unreadable` (the file
could not be fetched or read; there is nothing else there). On a lap: `short_lap` and
`extra_lap`.

## When it runs, and once

The webhook is the path; the hourly poll is the backstop. The stored stats themselves say a
session has been read, rather than a ledger, so a workout whose plan was rewritten is picked
up by the next pass rather than being stuck. One already read is left alone **unless the
platform now names a different activity** for the same session.

An unreadable recording is stored as *saying* that, with the reason, and tried **three
times**, never twice inside half an hour — three webhook deliveries in a minute are one
outage, not three tries at it.

`syncNow` reads no recordings at all: somebody is waiting on it, and a recording is a
download and a FIT decode. At most **five** are read per webhook or scheduled run, shared
across every athlete it visits, and a body over **8 MiB** is refused.

The other way in is `POST /api/workouts/:date/:id/recording`, for an athlete whose watch
never reaches a platform this server can read — the [iOS app](ios.md) posts one built out of
Apple Health. Same `statsFrom`, same column, bytes dropped; it also carries the completion,
answers an unreadable file with a 400 rather than storing `source_unreadable`, and records
the source as `upload`. Where a platform is also connected its copy of the same session
overwrites these numbers on the next pass, which is the right way round: the platform holds
the file this server can go back to. See [api.md](api.md#posting-a-recording).

## Where it sits

`src/stats.ts` does the decode, the mapping, the quarters and the flags;
`src/platforms/index.ts` calls `readStats` where a completion is applied; `stats` is a
column on `workouts` (migration 0010), so it ages out with the retention window, moves day
with the workout, and goes when it is deleted. The dashboard shows it under a completed
workout, with the lap table only where the laps were matched.

**A plan is frozen once a session has been recorded against it** — the mapping names steps
by position. See [workouts.md](workouts.md#saying-how-it-went).

**Reading a workout does not read its laps.** Every query but one takes the column through
`json_remove(stats, '$.laps')`; `db.getStats` is the one read that asks for the whole
document, and `get_workout_stats` is its only caller. Listing three weeks would otherwise
parse a page of laps per workout to throw all of them away.

`get_workout_stats` answers with the workout's `comment` beside the figures — a lap that
fell out of its band because they cut the session short reads very differently once that is
on the page.
