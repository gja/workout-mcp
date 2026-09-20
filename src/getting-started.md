# Getting started

Get this athlete's context written: the three documents an assistant reads
before it plans anything — **workout zones**, **scheduling instructions** and
**current plan**. Read what is already there, interview them for the rest, and
finish with all three written.

## Read what is already there first

Do not open with a question. Call `get_workout_zones`,
`get_scheduling_instructions` and `get_current_plan`, and call
`get_workout_library` — the fourth document, read-only here, which already
describes swim, bike and run session shapes, so the questions below can be
about *this* athlete rather than about what an interval is. If any of the three
has something in it, also call `list_workouts` and `list_recorded_workouts` to
see what has actually been happening, and `get_workout_stats` on a recent
session or two where a plan exists to compare against.

What comes back decides what this conversation is:

- **All three `markdown: null`** — a genuine setup. Run the whole interview.
- **Some written** — read them before asking anything, then say back what you
  found and ask only what is missing or has gone stale. Someone who has zones
  and no plan is asked about their goal, not about their FTP.
- **All three written** — this is not a setup, and say so. Work out from the
  documents and the recent sessions what has moved: a review trigger in
  `workout-zones` that has fired, a block in `current-plan` whose weeks have
  run out or been missed, a constraint in `scheduling-instructions` that the
  sessions they actually did no longer match. Propose those changes and ask
  before making them.

Either way, whatever is already written you are about to **replace in full** —
`update_context` has no partial edit — so show them what is there and confirm
before you overwrite it.

## How to run the interview

Ask in the rounds below, a round per message, so they answer a related group at
a time rather than a questionnaire or twenty separate turns. Skip what they
have already told you, and skip whole rounds their answers make irrelevant —
someone who only swims is not asked about FTP.

**Never invent a number.** A guessed threshold is worse than a missing one: it
looks like a measurement and gets planned against for weeks. Anything they do
not know is written as `*not set*`, next to the test that would set it and a
note that targets stay effort-based until then.

### Round 1 — sport and goal

- Which sports: running, swimming, cycling, triathlon, or some mix.
- What they are training for, and when. A dated race, a distance with no date,
  or general fitness are all fine answers — but a date changes everything
  downstream, so ask for one.
- Recent times, and how recent. Race results, time trials, a parkrun, a hard
  session they remember. For each: distance, time, and roughly when.
- What they are doing now — hours or sessions a week, longest recent session.
  A block that starts from what they actually do survives contact with week 2.

### Round 2 — how much of this they want done for them

Ask directly: should the assistant **manage the weekly schedule** — hold a
multi-week plan, and each week place the coming week's sessions onto days — or
**only write individual workouts** when asked?

- **Managing the schedule** means all three documents, including a plan with
  weeks in it, and a standing answer to "when does next week get scheduled".
- **Individual workouts only** means zones and scheduling instructions are
  still worth having (they are what makes a one-off session fit), and
  `current-plan` says so: what they are working towards, and that no week-by-week
  plan is held here.

### Round 3 — the week they actually have

This is what `scheduling-instructions` is made of, and vague answers here are
what produce sessions that get skipped.

- **Weekdays: how long a session can be**, warmup and cooldown included. Ask
  for a hard ceiling, not an ideal.
- **Weekends: how long**, and which weekend day is the reliable one.
- **How many sessions a day.** One most days? Ever two, and on which days?
  Does a brick count as one slot or two?
- **Which days are off**, and which are fixed (a club run on Tuesday, a squad
  swim on Thursday, a long ride on Saturday).
- **Spacing rules.** How much they want between hard sessions, what must never
  go back to back, whether a hard day has to be followed by an easy one.
- **Notice.** When they want the coming week scheduled — the Sunday before, a
  fortnight out, on request.
- **What gives way when the week is tight.** Ask which session gets dropped
  first; the answer is worth more than any other line in the document.

### Round 4 — numbers, per sport

Only for the sports they actually train. For each number ask where it came
from and when, and write that alongside it.

- **Running:** threshold pace or a recent race, max HR or threshold HR,
  kilometres or miles.
- **Cycling:** FTP and when it was last tested, max HR, whether they have a
  power meter at all — no power meter means HR and perceived effort bands.
- **Swimming:** CSS or a recent 400m and 200m, pool length, and whether they
  swim in a pool, open water or both.
- **Everyone:** age, if they are willing, when max HR is a guess rather than a
  measurement. And **resting HR** where a watch records one: it is what makes
  heart rate reserve available, and a percentage of reserve is not the same
  band as the same percentage of max.

**Max HR is usually already on their watch**, so ask where their sessions are
recorded before asking them for a number. The highest heart rate in a hard
recent session is a measurement, and it is the one figure in this round most
athletes have without testing for it.

- **Ask which platform** their training ends up in — Apple Watch, Garmin,
  Strava, Coros, Polar, Wahoo, Whoop.
- **If they have the WorkoutsMCP iPhone app, it has already done this.**
  *Settings › Heart rate* reads a year of Apple Health and gives back an average
  resting heart rate and an observed maximum — the third-highest day of that
  year, so a single sensor spike cannot set it — with a button that copies both
  to paste here. Ask them to open it rather than walking them through the
  Fitness app.
- **If they are not sure**, ask what is on their wrist and whether it syncs to a
  phone: the watch names the app. Apple Watch is the Fitness or Health app,
  Garmin is Garmin Connect, Coros and Polar are their own apps, and a chest
  strap with no watch usually lands in Strava.
- **Where to look**, roughly: Apple — a hard workout in Fitness, then its heart
  rate chart and the peak figure. Garmin Connect — an activity's max HR, or the
  all-time figure under its performance stats. Strava — max heart rate on an
  activity page, or the seasonal maximum in the heart rate zone settings.
- **Take it from sessions, not from the profile field.** The max HR a platform
  shows in its zone settings is often 220 minus age, entered once and never
  looked at again — a guess wearing a measurement's clothes. Ask for the highest
  figure they can see across a few hard efforts instead.
- **Two or three sessions agreeing is the signal.** A wrist sensor spikes, so a
  lone 210 with nothing near it in any other session is an artefact. Write what
  survives that check as an observed maximum, with the session and the date it
  came from, and note it is a floor — a true max needs an effort hard enough to
  find it. Nothing that agrees means `*not set*`.

### Round 5 — how the session reaches them

Ask what happens on the day: does a watch play the session through the
intervals, or are they reading it off a screen? Then say which road fits what
they already own, because it is one setup done before the first session rather
than after it.

- **Apple Watch** — two ways, and suggest this one first: connect
  **intervals.icu** on the dashboard and follow the session with **Watchletic**
  on the watch, which plays a planned workout through its intervals (about $2;
  intervals.icu's own app is free and does the same job). The alternative uses
  only Apple's apps — the **WorkoutsMCP iPhone app** schedules the plan into the
  Workout app and brings the recorded session back here, with no intervals.icu
  in the middle. It is free but invite-only for now: tell them to write to
  <tejas@gja.in>.
- **Garmin, Coros, Polar, Suunto, Wahoo** — **intervals.icu**, connected here
  under *Setup › Training platform* and to the watch's own platform at their
  end. Nothing to install on the watch; its own workout screen runs the session.
- **Wear OS** — **intervals.icu** again, which reads what Google Fit holds, with
  Watchletic on the watch.
- **Nothing on the wrist, or a watch with no connector** — the plan is on the
  dashboard calendar and on intervals.icu: read the session off a screen and
  mark it done.

Write the answer into `scheduling-instructions`, because it decides how a
session is written: a watch playing intervals needs targets an alert can hold,
which is the next round, while a session read off a screen can carry its intent
in words.

### Round 6 — indoors or outdoors, and how they follow a target

Ask per sport: treadmill or road, trainer or road, pool or open water, or both.
It changes the sub-sport a session is written with and how wide its targets can
be.

Then ask how they follow a target mid-session — a watch alert, glancing at the
screen, or by feel. If it is an alert, the band has to be one an alert can
hold, which is the whole reason for the widths in the next section.

### Round 7 — anything that constrains the plan

- Injuries, recurring niggles, anything a session must not do.
- Strength, physio or other training that takes a slot in the week.
- Heat, altitude, hills, treadmill-only winters — whatever makes their paces
  not mean what they would elsewhere.
- Anything they were told by a coach that they want kept.

## Then write the documents

Draft all three, show them, take corrections, and only then call
`update_context` once per kind: `workout-zones`, `scheduling-instructions`,
`current-plan`. Markdown prose, written for the assistant that reads them next
week — not for a parser. Nothing in them is validated, so a heading they find
readable beats a format.

### `workout-zones`

The single source of truth for physiology, and the document every target is
anchored to. One section per sport they train, and nothing else duplicating the
numbers.

- **Running:** pace bands (easy/recovery, long run steady, tempo, threshold,
  VO2max, and goal race pace if there is a goal), plus HR bands off max or
  threshold HR. Note that easy running is best prescribed on heart rate rather
  than pace.
- **Cycling:** watt bands as a percentage of FTP, with an explicit lower and
  upper watt figure on each.
- **Swimming:** per-100 bands off CSS, and the pool length they were measured
  in.
- State the basis at the top of each section — "FTP 200 W", "max HR 190",
  "CSS 1:45/100 m" — and the date it was set. Where a resting HR is known, write
  it beside the max and **say which of the two the heart rate bands are
  percentages of**: max HR, or heart rate reserve — max minus resting, Karvonen.
  They are different beats, and a band that does not say which is one nobody can
  check.
- Close with **review triggers**: the events that make these numbers stale. A
  completed ramp test or time trial, an easy session sitting below its HR band
  two weeks running, intervals finished repeatedly well inside or outside
  target, a planned test in the current block.

### `scheduling-instructions`

How sessions get placed, and how wide the targets written into them may be.
Everything from Round 3, plus these, which they will not have thought to ask
for:

- **Target bands are tolerances, not zones.** `workout-zones` stays the
  physiology and the single source of truth; a band written into a workout may
  be wider than the zone it comes from, and overlap the next one, as long as
  the intent of the session survives.
- **Outdoor running: at least 0:30/km wide, and up to a minute.** Wider still
  where something makes pace genuinely unreliable — trails, hills, heat, traffic,
  a route full of junctions — and say why in the notes when you go past a minute.
  Real pace on the road moves 20–40 s/km within a single interval from terrain,
  junctions, wind and ordinary variation. A 0:10 band reports honest running as a
  miss, which makes the planned-versus-actual review worthless. A band that is too
  wide costs far less than one that is too narrow: the first is vague, the second
  is wrong. Widen both ways, goal race pace included, and say in the notes where
  inside the band to sit.
- **Cycling: at least 25 W wide**, indoors or out. Narrower than that on a
  trainer measures the trainer, and outdoors it measures the hill.
- **A floor for easy riding**, if they have one — the lowest watts worth
  pedalling, applied to warmups, recoveries and cooldowns too.
- **Treadmill and indoor trainer work can be narrower**, because the machine
  holds the pace or the watts. Say so rather than applying the outdoor minimum
  everywhere.
- **Heart rate needs no minimum width**: it moves slowly and its bands are
  already effort-shaped.
- If a goal race pace comes from arithmetic — 6:00/km for a sub-60 10K — say
  that a certified course records 1–3% long on a watch, so the band written
  into sessions should reflect the race rather than the calculator.

### `current-plan`

What block they are in and what it is for.

- Goal, date, and the honest gap from where they are now to it.
- The shape of a normal week: how many key sessions, what each one is for, what
  is optional.
- If they asked for a managed schedule, the weeks themselves — each with a
  one-line intent and its key sessions, written as **zone names, never numbers**,
  so the plan cannot drift from `workout-zones`.
- A benchmark or test somewhere in the middle, with what each outcome means for
  the goal, and a note that it triggers a zones review.
- Standing notes for whoever schedules it: that sessions are undated until the
  week they are placed, that every number comes from `workout-zones`, and what
  to do with a week that gets missed.
- If they only want individual workouts, this is short: the goal, the shape of
  a week they aim for, and an explicit line saying no week-by-week plan is held
  here.

## Finally

Tell them what was written, that they can edit any of it on the dashboard, and
that the workout library — the session shapes — lives there too. Then offer the
next step and let them choose: a week of workouts written now, or a scheduled
task in their assistant that every Sunday reviews the week just gone and places
the coming one, so the weeks keep arriving without them having to ask.
