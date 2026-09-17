# The iPhone app

`ios/` is an iPhone app that carries a plan out to Apple's own Workout app and the
recorded session back. It is the second way in and out of this server — intervals.icu is
the first — and the one for an athlete whose watch is an Apple Watch and whose sessions
therefore never reach a platform with an API this server can read.

Building it is [ios/README.md](../ios/README.md). This is what it does and why it is
shaped the way it is.

## There is no watch app

The plan is scheduled through **WorkoutKit**, which is Apple's API for exactly this: an
app on the phone hands `WorkoutScheduler` a `CustomWorkout`, and it appears in the Workout
app on the watch, on the day it was planned for, alongside anything else the athlete
follows. The watch app that runs it is Apple's.

That decision is the whole architecture. A watch app would mean a second target, a second
authorization, a WatchConnectivity session to keep in step, and a workout engine written
here — to end up with something the athlete already has, and worse. What is given up is
control over what the watch shows mid-interval, which is not worth any of that.

## The plan, in Apple's shape

The two models line up better than they have any right to:

| workout-mcp | WorkoutKit |
| --- | --- |
| a `warmup` step first | `CustomWorkout.warmup` |
| a `cooldown` step last | `CustomWorkout.cooldown` |
| `{ repeat: 8, steps: [...] }` | `IntervalBlock(steps:iterations:)` |
| `intensity: rest` or `recovery` | `IntervalStep(.recovery, …)` |
| `goal_s`, `goal_meters`, no goal | `.time`, `.distance`, `.open` |

The app asks for the plan already resolved — `GET /api/workouts/:date/:id/plan`, one
duration and up to two targets a step, repeats kept — rather than the steps as they were
written. There is one resolver, in `src/resolve.ts`, and re-implementing it in Swift
would be a second set of rules for what a workout may say. That route exists for this
app and for anything else that wants to schedule a plan rather than render it.

**Two kinds of target are dropped rather than guessed at.** A bound written as a
percentage — `85%` of max heart rate, `95%` of FTP — is a number only the athlete's own
profile holds, and the app does not hold it. And a half-open target, `4:15/km or faster`,
has no range to alert against. In both cases the step goes to the watch with its duration
and no alert, which is the honest reading: the step still runs, the watch simply does not
beep at it. Inventing the missing end would put a band on the watch that nobody chose.

A repeat inside a repeat is flattened, because `IntervalBlock` does not nest and the plan
format allows two levels. The reps are all there; only the grouping is lost.

## The session, coming back

HealthKit stores a workout as a handful of series that agree on nothing — a route of
irregular locations, heart rates every few seconds, distances as sums over intervals of
their own choosing. `Health/SessionReader.swift` walks a one-second timeline and fills
each second from whichever series covers it. A second nothing covers stays empty rather
than becoming zero, for the reason [stats.md](stats.md) gives: a zero heart rate
corrupts every average computed downstream.

Laps come from `HKWorkoutActivity` where the watch recorded one per interval, from
`.segment` and `.lap` events where it did not, and otherwise the session is one lap. The
server's lap matching copes with all three, and says `unmatched` rather than guessing when
the mapping does not line up.

### Altitude a GPS had not settled on

One series is read twice, because it arrives wrong often enough to matter. A cold start can
spend its first fixes hundreds of metres from where it is and then step to the truth in a
single sample — a real recording here opens at 212 m, is at 904 m two seconds later, and
stays there for the rest of the hour.

Nothing downstream can tell that from a hill. The 3 m gate below keeps sensor drift out of a
climb, and drift is what it is built for, so it reads the step as 693 m of ascent on a
7.4 km road run. Grade, climb rate and every lap figure the server works out from the records
are wrong behind it too.

So the altitude trace is cut wherever it moves faster than an athlete could — ten metres a
second, which nothing that is a measurement will reach — and only the longest run of readings
is kept. The rest lose their altitude and keep everything else. Dropping rather than mending
is the same honesty as the empty second above: a FIT record's altitude is optional, and
leaving it out says nothing was measured, which is true, where a repaired number would be one
nobody stood at. A recording whose altitude never does anything impossible is a single run
and loses nothing.

## The file it writes

Then it is written as a FIT activity file, on the phone, by
[Garmin's own Swift SDK](https://github.com/garmin/fit-swift-sdk) — the same profile
version, 21.214, as the `@garmin/fitsdk` the server decodes with. The SDK owns the header,
both CRCs, the definition and data records and every field's scaling; what `ios/Fit/` still
decides is which messages an activity needs and what goes in them.

It goes in full. A `record` carries position and fix accuracy, altitude with the climb rate
and grade derived from it, speed, cumulative distance, heart rate, power, cadence — with
the half-stride in `fractional_cadence` rather than rounded off — the running dynamics
Apple records, respiration rate and cumulative energy. The `session` and every `lap` carry
the summary: totals, averages, maxima, minima, the bounding box, start and end position,
work in joules and normalized power.

Two of those have a method rather than a formula, and both are computed **the way this
server computes them** when a file leaves them out: elevation gain behind a 3 m noise gate,
and normalized power as Coggan's rolling 30-second average. A figure the file carries wins
over one derived here, so the two agreeing is what stops the same session reading
differently depending on where its numbers came from. The settling above is a filter on what
goes into the gate and not a change to it — both ends still run the same arithmetic, on a
trace the phone has already taken the impossible out of.

## The id in the file


The workout's `<date>/<id>` travels in the file as a developer field on the `session`
message, named `workout_mcp_id`. Developer fields are the FIT spec's own extension point,
so a decoder that has never heard of this one skips it and one that has can read it
straight back.

The upload does not need it — `POST /api/workouts/:date/:id/recording` names the workout
in its path — and that is the point: the file is self-describing wherever else it ends up,
without the server having to trust something inside it over the route it arrived on.

The file is named `yyyy-mm-dd-<id>-<name>.fit`, which is what `src/recordings/` calls the
same session when it comes back out of an archive and what `src/drive/` calls it in a
connected drive. One session reaching an athlete by three routes should be recognisable as
one file without opening any of them, so the app runs the server's own `safe()` rules on the
name rather than nearly running them.

The id is the **planned workout's** — this server's own, the same one in the URL and inside
the file as `workout_mcp_id`. HealthKit's own identifier for the session is not used: it
means nothing to anything the file will reach. A session with no workout to name is
`unmatched`, which is the honest reading of an empty slot and better than filling it with an
id of a different kind.

Matching a recorded session to the plan it was for is tried two ways, in order: the plan
id the watch recorded, looked up in an index the app wrote when it scheduled the workout;
and the one workout of that sport planned for that day, where there is exactly one.
WorkoutKit plan ids are **derived** from the workout key rather than allocated, so
scheduling a workout again replaces the plan on the watch instead of leaving two.

**And then nothing.** There was a third way — a picker, always there, the athlete's own
choice winning over both — and it is gone. A session the watch named is certain and a day
with one workout of that sport on it is as good as certain; everything left over is a
question the app is in the worst position to answer, and asking it puts a menu of every
workout in the fortnight in front of somebody whose only evidence is the same day and
sport the app already read. What that menu produced when it was wrong was a completion to
undo and a page of stats to distrust — see ["A plan is frozen once a session has been
recorded against it"](stats.md#where-it-sits). So a session the app cannot place says so,
and is not uploaded; the workout it belongs to is named where the plan, the dashboard or
an assistant can settle it. Which workout a session was is shown as a fact and a link to
the plan, not as a field.

## Three tabs

**Planned**, **Executed**, and **Settings** — the plan ahead, the sessions behind, and who
is signed in.

### Planned

At the top, the one line the sync exists to make true: *Synced to Apple Fitness · 8 planned
workouts · 2 min ago*, and tapping it syncs again. Opening the app syncs on its own when the
last one was over half an hour ago, because a status line that is merely the last thing that
happened is worse than none. It sits above the plan rather than in Settings because it is a
fact about the plan underneath it — "is this on my watch" is read in the same glance as
"what is on Saturday", not on a screen the athlete goes looking for.

Under it, what is coming, and a tap gets the steps: the plan as
`GET /api/workouts/:date/:id/plan` resolves it, one duration and up to two targets a step,
repeats kept. It is the same route the sync schedules from, so the screen and the watch are
reading the same answer rather than two renderings of the same steps.

It is grouped the way the athlete already thinks about it — **Missed**, **This week**,
**Next week** — rather than as one list fourteen days long. A fortnight in date order asks
somebody to work out where this Sunday stops and the next one starts every time they open
the app, which is the one question a week heading answers for free. The weeks are the
athlete's own: `Calendar.current` decides whether one begins on a Monday or a Sunday, because
"next week" is something they say rather than seven days counted from today. Anything the
server holds past the second week is **Later**, which is a small group by design — the plan
runs a fortnight and two weeks rarely leave much over.

**Missed** is planned, in the past, still not done, and it sits first. Not a scolding —
those are exactly the sessions a sync reaches two days back for, so they are on the watch
and can still be done. It is its own list rather than part of the week because a session
behind is a decision to make, and the week ahead is not.

An empty group is left out rather than shown empty, so a heading on that screen is always a
promise that there is something under it.

Completed workouts are not here. They are a session now, and sessions are the next tab.

### Executed

Every session there is evidence of, newest first, from two places at once: what Health
recorded on this phone, which is what can still be uploaded, and what the server has
already read a file for, which is where the numbers come from. Most sessions are both, and
the athlete should not have to know which — a tick says the server has the file.

A tap opens the session, and the session is **the server's reading of it**. The totals, the
laps, each lap's quarters, and the band each lap was aimed at are all
[`GET /api/workouts/:date/:id/stats`](stats.md), which is the document the dashboard and
`get_workout_stats` read too. Nothing on that screen is computed on the phone. The app
already has HealthKit's own series in hand and could average them itself, and that is
exactly the reason not to: two sets of numbers for one session, disagreeing at the edges —
where a pause ends, what counts as moving — is worse than one set that is sometimes not
there yet.

The laps are the point of the screen. One row a lap, what it was planned to be beside what
it did on that same metric, and how much of it was spent inside the band. A tap opens one
lap in full: heart rate average, maximum and **minimum**, pace, power, cadence, the ground
underneath, the target with time above and below it, and the **quarters** — four equal
segments of the lap, each metric averaged within its own. Those are as close to a trace as
this gets, deliberately: the server keeps a page of numbers and not the recording, so there
is no second-by-second heart rate anywhere to draw. What the quarters give instead is the
thing an average hides — a rep that started at 6:00/km and finished at 6:40 reads as a
clean hit until you see its four.

Below all of it, where Health has the session, are the two buttons this app started as:
*Generate .fit*, which writes the file on the phone, and *Upload*, which posts it.

Building the file is never what anybody wanted — it is what they had to do first — so the
share sheet opens on its own the moment it is written, and every way out of the screen is in
there: AirDrop, Files, Mail, and **Upload to WorkoutsMCP** as an action of this app's own
beside them. That is `UIActivityViewController` with a `UIActivity` rather than SwiftUI's
`ShareLink`, which can do neither half — it opens only when its own link is tapped, and it
takes no actions.

The upload stays on the screen behind as well. A share sheet is gone the moment it is
dismissed, and an upload reachable only from inside one would mean building the file a second
time to find it. Where the session has no planned workout to be filed against, the action is
not offered at all rather than offered and refused: a list of places to send something should
only hold places it can go.

### Settings

Who is signed in, which deployment this build talks to, and the way out. Nothing about the
plan is here: everything that was is on the tab with the plan on it.

### What a sync sends

**Two days back to seven days ahead**, minus anything already done, and then it **prunes**:
whatever this app put on the watch outside that window comes off, so the two really do agree
rather than accumulating. Plans the athlete follows from elsewhere are not this app's to
touch, and are left alone — only ids in this app's own index are removed.

Back as well as forward because a missed day is a session still worth doing, and needing
the app to get it back is a worse answer than it being there already. A past-dated workout
is scheduled for the next whole hour rather than the hour it was planned for, since the
scheduler has nothing to show for a time that has gone — the next *whole* hour so that
resyncing ten minutes later lands on the same time and does not rewrite the watch for
nothing. Seven ahead rather than the fourteen the server holds: the far end of a fortnight
is a plan still being edited, and putting it on the watch is a list to scroll past.

### And with the app shut

HealthKit launches the app in the background when a workout is saved, which is the only way
a recording reaches this server without the athlete opening anything. What happens then is
narrower than what happens on the screen: a session is built and uploaded **only** where the
watch itself named the plan it was run against.

The day-and-sport fallback is deliberately not used there. It is a good guess, and a good
guess is the right thing to offer somebody who is looking at it and the wrong thing to act
on unattended — a session filed against a workout nobody chose is a completion to undo and a
page of stats to distrust. Those wait in the Executed tab.

The plan travels the other way with the app shut too, and nothing wakes the app for it: a
workout added on the server is a change no device here hears about. So the app asks iOS for
a background refresh every four hours — `BGAppRefreshTask`, registered in the app's own
initialiser because `BGTaskScheduler` takes a handler only before launching finishes — and
reads the plan when it is granted one. Four hours is a floor and not a promise: iOS decides
when these actually run, from how often the app is opened and what the battery is doing. That
is the right shape for it, because a plan written this morning should reach the watch today
without anybody opening anything, and none of it is urgent to the minute.

A turn asks for the next one before it does any work, since iOS holds one request per
identifier and never repeats one on its own — a turn that is cut short and did not re-arm
would be the last there ever was. Signed out, or a server that cannot be reached, is not
recorded anywhere: there is nobody to tell, and the next turn tries again.

What that turn runs is `Plan/PlanSync.swift`, which is what the athlete's own tap runs too.
It holds the window, the scheduled times and the prune, and the model on the screen is left
with the counting-out a status line needs. A background sync that placed workouts by rules
of its own would be a watch that changed depending on which of the two last ran.

## Signing in

The app asks for the address of the deployment — [workouts-mcp.com](https://workouts-mcp.com)
is filled in, because this server is also something you can host yourself — and nothing else. It discovers the
authorization server, registers itself (RFC 7591), and runs an authorization code flow
with PKCE in an `ASWebAuthenticationSession` — the same door an MCP client comes through,
described in [mcp.md](mcp.md). The consent page is the server's own, so the Google or
Apple sign-in happens there and the app never sees a credential of the athlete's.

Then it trades the grant, once, at `POST /api/app-token`, and throws the grant away. An
OAuth access token reaches `/mcp` and nothing else, and this app wants the REST API; the
exchange and why it is one route rather than a second handshake are in
[auth.md](auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).
What the app keeps is an ordinary `wk_` token, in the keychain — listed on the dashboard
under *API tokens* as "WorkoutsMCP for iOS", and revoking it there signs the app out. The
trade is behind its own `app-token` scope, which this app asks for and an MCP client does
not; [auth.md](auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token)
says why.

There is no second door. Pasting a `wk_` token was offered at first and taken out: it is a
worse sign-in for everybody who has a browser, and the athlete who genuinely needs one is
using the dashboard or an MCP client rather than this.

`ASWebAuthenticationSession` claims its callback scheme itself, so the app registers no
URL type and nothing else on the phone can be handed the authorization code.

## What the app never holds

The FIT file is written to the temporary directory so it can be shared, and posted from
there. Nothing else about a session is stored on the phone: no copy of the recording, no
cache of the plan, no credential outside the keychain. The only thing that persists is the
index from a WorkoutKit plan id to a workout key, which is a few hundred short strings in
`UserDefaults` and is what lets a session recorded a fortnight later still name the plan
it was for.

## Open source, no secrets

The app ships in this repository under the same MIT licence as the rest of it, and holds
no secret to ship: it is a public OAuth client that registers itself with whatever
deployment it is pointed at, so there is no client secret, no API key and no signing
identity in the project. The credential it ends up with is minted per install and lives in
that phone's keychain. The only thing a build needs that is not in the repo is an Apple
signing team, which is the developer's own.
