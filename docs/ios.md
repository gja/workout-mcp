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

Then it is written as a FIT activity file, on the phone, by a small encoder in `ios/`
rather than by a library — there is no Swift FIT SDK, and the file an activity needs is
seven message types. Its field numbers and enums were read out of the profile that ships
with `@garmin/fitsdk`, which is the decoder the server reads the file back with, and the
byte layout was round-tripped through that decoder and through `statsFrom` before it was
written in Swift.

## The id in the file

The workout's `<date>/<id>` travels in the file as a developer field on the `session`
message, named `workout_mcp_id`. Developer fields are the FIT spec's own extension point,
so a decoder that has never heard of this one skips it and one that has can read it
straight back.

The upload does not need it — `POST /api/workouts/:date/:id/recording` names the workout
in its path — and that is the point: the file is self-describing wherever else it ends up,
without the server having to trust something inside it over the route it arrived on.

Matching a recorded session to the plan it was for is tried three ways, in order: the plan
id the watch recorded, looked up in an index the app wrote when it scheduled the workout;
the one workout of that sport planned for that day, where there is exactly one; and then
the athlete, from a picker that is always there. WorkoutKit plan ids are **derived** from
the workout key rather than allocated, so scheduling a workout again replaces the plan on
the watch instead of leaving two.

## Signing in

The app asks for the address of the deployment and nothing else. It discovers the
authorization server, registers itself (RFC 7591), and runs an authorization code flow
with PKCE in an `ASWebAuthenticationSession` — the same door an MCP client comes through,
described in [mcp.md](mcp.md). The consent page is the server's own, so the Google or
Apple sign-in happens there and the app never sees a credential of the athlete's.

Then it trades the grant, once, at `POST /api/app-token`, and throws the grant away. An
OAuth access token reaches `/mcp` and nothing else, and this app wants the REST API; the
exchange and why it is one route rather than a second handshake are in
[auth.md](auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).
What the app keeps is an ordinary `wk_` token, in the keychain — listed on the dashboard
under *API tokens* as "WorkoutsMCP for iOS", and revoking it there signs the app out. A
token pasted in by hand works just as well, for a deployment where the browser round trip
is not wanted.

`ASWebAuthenticationSession` claims its callback scheme itself, so the app registers no
URL type and nothing else on the phone can be handed the authorization code.

## What the app never holds

The FIT file is written to the temporary directory so it can be shared, and posted from
there. Nothing else about a session is stored on the phone: no copy of the recording, no
cache of the plan, no credential outside the keychain. The only thing that persists is the
index from a WorkoutKit plan id to a workout key, which is a few hundred short strings in
`UserDefaults` and is what lets a session recorded a fortnight later still name the plan
it was for.
