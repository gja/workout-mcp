# The iPhone app

`ios/` carries a plan out to Apple's own Workout app and the recorded session back — the
way in for an athlete whose watch is an Apple Watch and whose sessions therefore never
reach a platform this server can read. Building it is [ios/README.md](../ios/README.md).

## There is no watch app

The plan is scheduled through **WorkoutKit**: the phone hands `WorkoutScheduler` a
`CustomWorkout` and it appears in the Workout app on the watch on the day it was planned
for. A watch app would mean a second target, a second authorization, a WatchConnectivity
session and a workout engine written here — to end up with what the athlete already has.
What is given up is control over what the watch shows mid-interval.

## The plan, in Apple's shape

| workout-mcp | WorkoutKit |
| --- | --- |
| a `warmup` step first | `CustomWorkout.warmup` |
| a `cooldown` step last | `CustomWorkout.cooldown` |
| `{ repeat: 8, steps: [...] }` | `IntervalBlock(steps:iterations:)` |
| `intensity: rest` or `recovery` | `IntervalStep(.recovery, …)` |
| `goal_s`, `goal_meters`, no goal | `.time`, `.distance`, `.open` |
| `completed_at` | `WorkoutScheduler.markComplete` |

The app asks for the plan already resolved (`GET /api/workout-plans`) rather than the steps
as written: re-implementing `src/resolve.ts` in Swift would be a second set of rules for
what a workout may say.

**A half-open target is filled at the open end.** WorkoutKit's one-sided alerts hold a
single `target` and no side, and Apple does not say which side the watch reads it as, so
`slower than 7:45/km` and `faster than 7:45/km` would go out identically. The app sends a
range with a stand-in — 20:00/km and 2:00/km, 40 and 220 bpm, 10 and 1000 W, 20 and 200 rpm
— each past what a session reaches and no further, because a figure outside what the watch
has a dial for is worse than a wide band, and a zero end reads as no target at all.

**A heart rate or cadence alert is not read in hertz.** `HeartRateRangeAlert` and
`CadenceRangeAlert` are typed `Measurement<UnitFrequency>`, and Apple divides the
measurement's base value by 60 to get the figure it shows. `UnitFrequency` has no case for
a rate a minute, so the app carries one of its own — and defines it with a coefficient of
**60**, not the 1/60 the physics asks for, so that the division lands back on the number
the plan wrote. Measured against a 40-148 bpm band: sent as 0.67-2.47 it read *0 BPM*, and
sent as 40-148 it read *1-2 BPM*.

**Everything `CustomWorkout.init` asserts is asked first.** It is not failable and does not
throw: handed something it will not take it traps, and the app goes down with
`EXC_BREAKPOINT` inside WorkoutKit. So `supportsActivity`, `supportsGoal` and
`supportsAlert` are all checked on the way in. An unsupported activity cannot be scheduled
and says so; a goal that does not fit falls back to running until the lap button; an alert
that does not is left off.

A percentage bound gets no alert either — there the number itself is missing, and only the
athlete's own profile holds it. **What cannot be alerted on is named instead**, appended to
`WorkoutStep.displayName` in the same words the workout reads in on the phone:
`Spin @ 85-95 rpm`.

A repeat inside a repeat is flattened, because `IntervalBlock` does not nest. The reps are
all there; only the grouping is lost.

## The session, coming back

HealthKit stores a workout as a handful of series that agree on nothing.
`Health/SessionReader.swift` walks a one-second timeline and fills each second from
whichever series covers it; a second nothing covers stays empty rather than becoming zero,
for the reason [stats.md](stats.md) gives. Laps come from `HKWorkoutActivity`, else from
`.segment` and `.lap` events, else the session is one lap.

**Altitude is read twice.** A cold GPS start can spend its first fixes hundreds of metres
out and then step to the truth in one sample — one recording opens at 212 m, is at 904 m two
seconds later, and stays there for the hour, which the 3 m gate reads as 693 m of ascent on
a 7.4 km run. So the trace is cut wherever it moves faster than ten metres a second and only
the longest run is kept; the rest lose their altitude and keep everything else.

## The file it writes

Written on the phone by [Garmin's own Swift SDK](https://github.com/garmin/fit-swift-sdk),
at the same profile version (21.214) the server decodes with. `ios/Fit/` decides which
messages an activity needs and what goes in them; the SDK owns the rest.

It goes in full — position, altitude, speed, distance, heart rate, power, cadence with the
half-stride in `fractional_cadence`, running dynamics, respiration and energy per `record`;
totals, averages, extremes, the bounding box, work and normalized power per `session` and
`lap`. Elevation gain and normalized power have a method rather than a formula and are
computed **the way this server computes them** — a 3 m noise gate, Coggan's rolling
30-second average — so a session cannot read differently depending on where its numbers came
from.

The workout's `<date>/<id>` travels as a developer field on the `session` message,
`workout_mcp_id`. The upload does not need it — the route names the workout — and that is
the point: the file is self-describing wherever else it ends up. It is named
`yyyy-mm-dd-<id>-<name>.fit`, running the server's own `safe()` rules, so one session
reaching an athlete by three routes is recognisable as one file.

**Matching a session to its plan is tried two ways, in order**: the plan id the watch
recorded, read off `HKWorkout.workoutPlan` — there is no metadata key to look it up by —
then the one workout of that sport planned for that day, where there is exactly one.

There is deliberately no third way. A picker was tried and removed: everything past those
two is a question the app is in the worst position to answer, and what it produced when it
was wrong was a completion to undo and a page of stats to distrust. A session the app cannot
place says so and is not uploaded.

**WorkoutKit plan ids are derived**, a SHA-256 of the workout key rather than something
allocated, so scheduling a workout again replaces the plan on the watch instead of leaving
two, and nothing has to be read back before a workout can go out. A digest does not come
apart again, so `PlanLink` writes the pair down when it schedules and reads the key back from
that index.

Packing the key into the id itself — the day in BCD, a byte an id character, into the bytes a
UUID leaves free — was tried and removed. All it bought over the index was surviving a
delete-and-reinstall, the credential being in the keychain where the index is not, and for
that it cost two id schemes at once and a silent dependency on `src/db.ts`'s id length and
alphabet. The move below is what actually goes wrong, and the index is where it was fixed.

**A workout moved to another day** is the one way date and id still come apart: the link names
the day the workout was on when it was scheduled, so the POST 404s and `Settled`, knowing no
better, writes it off for good. The server keeps a workout's id when it moves one, so the move
is legible — a link whose id appears under a different date is that same workout — and
`PlanLink.follow` rewrites those from the window `PlanSync` has already read, at no round trip.
It runs **after** the prune, because the prune reads the same links to decide what comes off
the watch and a link followed first would keep the old plan there. Two current keys sharing an
id move nothing: the app will not guess between them, and a session filed against the wrong
workout is worse than one that cannot be filed at all.

## Three tabs

**Planned** opens with the line the sync exists to make true — *Synced to Apple Fitness · 8
planned workouts · 2 min ago*, tappable to sync again. The app syncs on its own when the
last one was over four hours ago, or when the plan it has just read is not the one that
reached the watch: a status line that is merely the last thing that happened is worse than
none. Under it the plan is grouped **Missed**, **This week**, **Next week**, **Later**, with
an empty group left out. A week runs **Monday to Sunday** whatever the phone's locale says,
because it is a training week and the long run is on a Sunday — the same week
`src/client/dates.ts` groups the dashboard by. **Missed** sits first and is its own list,
because a session behind is a decision to make.

**Executed** lists every session there is evidence of, from two places at once: what Health
recorded on this phone, which is what can still be uploaded, and what the server has read a
file for, which is where the numbers come from. A tap opens **the server's reading of it**,
straight from [`GET /api/workouts/:date/:id/stats`](stats.md). Nothing there is computed on
the phone, although the app has HealthKit's series in hand: two sets of numbers for one
session, disagreeing at the edges, is worse than one set that is sometimes not there yet.

Below it, where Health has the session, one button: **Share .fit**, which writes the file
and opens the share sheet holding AirDrop, Files, Mail and **Export to WorkoutsMCP**. That
is `UIActivityViewController` with a `UIActivity` rather than SwiftUI's `ShareLink`, which
can do neither half. The file is real, on disk, because `UIActivityViewController` takes the
name and type from a URL, and it is not deleted on dismissal because a share target copies
asynchronously. Where the session has no planned workout to file against, the export action
is not offered at all.

**Settings** is who is signed in, which deployment this build talks to, the way out,
**Heart rate** (below) — and **Sync log**, a sheet over what the half of this app nobody
watches has been doing. A session
missing from the server is equally consistent with HealthKit never having woken the app, a
wake that was cut short, and a session this app will not upload unattended, and nothing in a
background launch can say which. So the sheet opens on three: whether Health can wake the
app, when it last ran with nobody looking and what came of it, and how many sessions have
gone up on their own. Under them is the event list, newest first, each line marked where it
happened unattended.

## Heart rate

*Settings › Heart rate* is the one reading of Health here that is not about a single
session: a year of it, reduced to the two figures a heart rate zone is anchored to — what
this athlete rests at, and the highest they have been recorded working. Round 4 of the
setup interview sends an athlete on this app here rather than walking them through the
Fitness app; see [prompts.md](prompts.md).

**The maximum is the third-highest day, not the highest.** A wrist optical sensor spikes,
and a lone 205 with nothing near it in any other day of the year is an artefact that would
otherwise set every band underneath it. The three days the figure is read off are listed
below it, so it can be checked rather than believed. It is still a floor — the hardest this
athlete has been *recorded* working, not the hardest they can work — and the screen says so
in the same words the interview does.

**A day, not a session.** HealthKit has a predicate for the samples of one named workout
and none for "any workout", so filtering to sessions would be a query per session. Two
statistics queries bucketed by day cover the year instead — daily maximum heart rate, daily
resting heart rate — and an all-out effort nobody thought to start as a workout counts for
it rather than being missed. A day Health has nothing for is absent rather than zero, for
the reason [stats.md](stats.md) gives.

**No zones are computed here.** The bands live in `workout-zones` on the server, which is
the single source of truth for physiology — the same reason the Executed tab shows the
server's numbers with HealthKit's series in hand. What this screen adds beside the two
measurements is heart rate reserve, max minus resting, which is what a Karvonen percentage
is taken of; and a button that copies the lot as prose to paste into the assistant, saying
of each figure where it came from and how far to trust it. An assistant handed a bare 186
cannot tell a measurement from a guess.

Resting heart rate is the one `readTypes` entry no FIT file carries, and it is there for
this screen alone. An athlete who declines it, or a watch that never wrote one, gets a
section saying so rather than an average of nothing.

## What a sync sends

**Two days back to seven days ahead**, done or not, and then it **prunes**: whatever this
app put on the watch outside that window comes off. Only ids in this app's own index are
removed — plans the athlete follows from elsewhere are left alone.

Back as well as forward because a missed day is a session still worth doing. Seven ahead
rather than fourteen: the far end of a fortnight is a plan still being edited.

**Every workout goes out on the day the plan gives it, and no time at all** — the date
components handed to `WorkoutScheduler` are the year, month and day, and Apple places it
within that day. A day already gone included: a missed Friday moved into today would show
in Apple Fitness under *Today*, beside the session actually planned for today, which is the
one thing it is not.

**A session already done goes out ticked**, so the days behind read as finished rather than
absent, and the workout is still there to start again. The tick is read back as well as
written, because a completion cleared in the Workout app is one this app's record still
claims.

**Most of a sync sends nothing at all.** A workout whose `updated_at` has not moved, on the
day it is already scheduled for, is skipped — its id left out of the ask and nothing
written to the scheduler. The app checks its own record against what
`WorkoutScheduler` is actually holding, because a plan the athlete deleted in the Workout
app is gone. A sync with nothing to do is one listing and one read of the scheduler.

The plans that *are* needed are fetched in **one request**, the stale ids comma-separated.
A workout the server no longer has comes back in `missing` rather than as a 404, and the
sync simply does not place it.

## And with the app shut

HealthKit launches the app in the background when a workout is saved, which is the only way
a recording reaches this server without the athlete opening anything. What happens then is
narrower: a session is built and uploaded **only** where the watch itself named the plan.

Being woken is three things, and they fail on different days.

- An **observer** answers a wake, registered in the app's initialiser because a background
  launch builds no view to register it from. HealthKit remembers that delivery was turned on
  for a type across restarts; it does not remember the callback.
- **Background delivery** causes a wake, and HealthKit refuses to enable it for a type the
  athlete has not authorised — which, on a first install, is every launch before they have
  been asked. So enabling it is re-tried at every launch and wherever authorization has just
  been granted. Attempted once and assumed, it leaves an app that would answer a wake
  perfectly and is never sent one.
- **Answering** is the one that turns itself off: HealthKit reads an observer that does not
  call its completion block as one that is not coping, and stops waking the app. The work
  can outlast what iOS grants a background launch, so `Wake` in `Health/BackgroundSync.swift`
  takes a background-task assertion and acknowledges exactly once — when the work finishes,
  or when iOS says the launch is over, whichever comes first.

**A wake is a request, not a promise.** Low Power Mode, a watch that has not synced the
session over, and the system's own view of this app all delay it; a force-quit stops it
until the app is opened by hand. So the same upload runs from three other places under
exactly the same rules: every `PlanRefresh` turn, opening the app, and the unlock below.

**And a wake on a locked phone can read nothing.** HealthKit encrypts what it holds with the
passcode, so a background launch while the phone is locked used to spend a round trip to be
told `Protected health data is inaccessible [com.apple.healthkit 6]` — which reads in the log
like a failure and is not one. `UIApplication.isProtectedDataAvailable` answers that without
the store, so the run now says *the phone is locked* and returns in milliseconds.

The wake is spent either way, because HealthKit does not send it again, so **the unlock is a
trigger of its own**: `protectedDataDidBecomeAvailableNotification` runs the same upload the
moment there is a passcode behind it, rather than leaving the session for the next wake or a
refresh turn hours later. It is registered at launch, not from inside a wake, since the
process that lost its turn is usually gone by the time anybody picks the phone up — and for
the same reason the flag saying a run gave up on the lock is in `UserDefaults`. Only that
flag makes the unlock a trigger: a phone is unlocked dozens of times a day, and a HealthKit
query on each one is exactly what the rest of this path exists to avoid. Its line is an
upload rather than a wake, because iOS did not run this app — somebody unlocked it — and the
count of background wakes is the one figure that says delivery works at all.

What this does not reach is the launch iOS has already ended: a notification needs a process
to deliver it to, so a wake that failed and was then terminated is found by the catch-up on
opening the app, as before.

**A refresh turn has to be declared, and the declaration has to reach the bundle.** iOS
grants `BGAppRefreshTask` only to an app whose `Info.plist` lists `fetch` under
`UIBackgroundModes` and the task's identifier under `BGTaskSchedulerPermittedIdentifiers`;
without both, `register` answers false and nothing is ever scheduled. Both keys live in
`ios/Info.plist`, next to the entitlements, and not in the build settings that generate the
rest of the plist: Xcode's generator honours a fixed list of `INFOPLIST_KEY_` names and drops
the ones it does not know without a word. Declared that way, the turn never came for a day,
and the tell was the app missing from *Settings › General › Background App Refresh*. An app
that declares the mode is listed there; check that before anything else.

**And a wake asks the server nothing before it posts.** It used to read the listing first —
three weeks of plan, over the slowest link in the path — to check `isDone` on one workout,
and a wake that ran out of time ran out of it there. Everything the POST needs is the
workout key, which `PlanLink` already holds from scheduling it, so the only question left is
whether this session is one the app is already finished with. `Health/Settled.swift` answers
that locally, and is written only where the answer **cannot change**: a session that went up,
one refused for a reason another run would get again, and one the watch never named a plan
for — which is fixed when it records the session. A failure another run might not hit is
deliberately not settled, so it is found again. A wake then reads Health, resolves one plan
id and posts — no round trip before the one that matters.

### The transfer does not belong to the wake

Even with nothing wasted it did not fit. Sending a session took **17 to 34 seconds** on device
against the roughly thirty a background-task assertion is given, so a 90-second walk was woken
59 seconds after the watch saved it, wrote `ran out of time`, and did that twice more before a
fourth attempt scraped through twenty minutes later. Delivery was never the problem; the work
was, and whether it fit was a coin toss.

So the network left the wake. `Api/SessionUpload.swift` hands the file to a **background
`URLSession`** — write a FIT to a temporary file, create an upload task, return — and iOS
transfers it after this process is suspended or gone, then relaunches the app purely to report
the result, which is a fresh budget for three `UserDefaults` writes.

The answer therefore arrives somewhere else, and three things follow from that.
`didCompleteWithError` settles the session and may run in a later launch, so the session
identifier is fixed, the session is recreated on **every** launch, and an `AppDelegate`
finishes the launch iOS makes to report. `Health/Handed.swift` holds the gap before `Settled`
— six hours rather than for ever, so a transfer the system loses is offered again the same
morning. And nobody is left to refresh afterwards, so a landing posts `sessionUploaded` and
`RootView` reads the plan again on it.

The foreground still waits: *Export* and the catch-up on opening the app have a whole app
lifetime and somebody watching.

**A landing is announced**, since by then there is usually no screen to announce it on. The
notification is **local** — the phone already knows the fact, so no server, no APNs and no
device token are involved — and it reads *your walk "90s walk II" has been marked complete*,
because the POST answers with the workout it just marked done and `SessionUpload` is already
holding that body to read a refusal out of. So neither the name nor the sport costs a request. Permission is asked for beside Health's, on a
foreground refresh, for the reason everything else in this section exists: a launch nobody is
looking at is the wrong moment to ask anybody anything. Refused, nothing is posted and nothing
else changes.

Telling those refusals apart matters more than it sounds. The listing used to filter a
deleted workout out before it was ever posted; without it, three deleted test workouts
`404`'d on every wake for a day, because only a success had ever been written down.

It sends **one session a run**, because a wake is about the session that just finished, and
whatever is behind it keeps until the next run or the next time the app is opened. And **one
run at a time**: opening the app starts the observer's own fire and the catch-up within a
moment of each other, and both used to reach the POST before either finished — one walk went
up three times. `Settled` cannot stop that by itself, since none of them has recorded
anything yet, so a second caller joins the run already going instead of starting another.

### And the reading is asked all at once

Moving the transfer out bought a second. The log timestamps each step, and on the wake that
showed it the network was the cheap end — *about to upload* at 11:44:02, *handed a session to
iOS* nine seconds later, *finished uploading* one second after that. Nine of the ten seconds
were reading the session out of Health and encoding the file, and both are still inside the
assertion.

That nine seconds was a **96-second indoor walk with no GPS and no power meter**, which is
about the smallest recording there is, so the cost was never the data. HealthKit keeps each
series separately and there is a query per series, and `SessionReader` was making twelve of
them one after another — heart rate, power, speed, cadence, distance, energy, breathing, the
three running dynamics, and the route — paying a round trip for each whether or not it had
anything to say. A walk has no power and no running dynamics; those queries cost what a query
costs anyway.

None of them depends on another, so they now go out together and the timeline is filled once
they have all landed. What the invariant there was ever about is the writing — one owner of
the samples at a time, and no await in the middle of filling them — and asking is not writing.

**Nothing is skipped for being inapplicable.** Power on a walk, running dynamics on a ride:
those come back empty, but they now come back empty alongside everything else rather than
after it, so leaving them out would save nothing a clock could read — and would quietly lose
a series the day a watch starts writing one.

And the split is written down rather than argued about. Every read logs what it spent asking
Health against what it spent filling the timeline, the route counted apart from the eleven
because a track arrives in batches rather than in one answer, and the line that hands the file
over says how long encoding took. Encoding is per-sample work — that walk is 97 records — so
it is not where nine seconds hides, but the log says which half it was rather than leaving it
to be reasoned out.

`Health/SyncLog.swift` records what each step did, because a wake that never arrives and a
wake that arrives and finds nothing are the same silence from outside the app. Delivery being
enabled or refused, every observer fire and its outcome, every session that went up or would
not, every plan written to the watch and every `PlanRefresh` turn all get a line — the last
hundred, in `UserDefaults`, because the process a wake happened in is gone by the time
anybody asks and it takes the console with it. Settings opens it as **Sync log**.

An upload is written down **before** it starts as well as after. Reading the session,
encoding the file and posting it are where a wake runs out of time, and a line written only
on success leaves nothing to say which of the three it died in.

A failure says what failed: a status and a message for the server, a domain and a code
otherwise, because `localizedDescription` alone names neither. And a run that sends nothing
says why — how many sessions it looked at, how many were already up, how many the watch never
named — since "nothing new to upload" against three recent sessions is not one fact but three.

**Each line records whether anybody was looking**, or the act of reading the log destroys what
is being looked for: `HKObserverQuery` fires an initial callback whenever it is executed, and
`start()` executes it on every launch, so opening the app to see the last wake causes one.
What separates them is `UIApplication.didBecomeActiveNotification`, which a background launch
never posts. Two other signals were tried and are not it: `UIApplication.applicationState`
can still read `.inactive` early in a HealthKit launch, and `scenePhase` is worse — SwiftUI
builds the scene and reports `.active` even there, so every wake recorded itself as a
foreground one. Only the unattended lines — marked 💤 — are evidence that iOS ran the app on its own.

**And the flag is corrected after the fact.** The observer's first fire lands before the scene
has connected and so before that notification can arrive, so a launch somebody made wrote a
wake marked unattended — and once nothing is left to send, that run finishes in milliseconds
and wins the race every time. Force-quitting the app and opening it read *last background wake:
just now*, which is how this was found. Becoming active within a few seconds of process start
therefore clears the flag on everything that process wrote, and takes those wakes back out of
the count. A few seconds and not ever: a background launch opened ten minutes later really did
run unattended until then.

**Copy** puts the sheet on the pasteboard as text, timed to the second where the list rounds to
the minute: it is read by somebody not holding the phone, and usually asked the order of two
things written moments apart.
