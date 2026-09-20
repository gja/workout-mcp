# Android watches, and how much app it takes to reach one

**Status: research only, nothing written.** The question was whether an Android
athlete can be served the way an Apple one is by [`ios/`](../ios.md), and whether
the app can be skipped entirely by handing the plan to Google's health platform
and letting each watch's own app pick it up.

**The short answer is that "Android" is two ecosystems and they have opposite
answers.** For a sports watch that happens to pair with an Android phone — Garmin,
COROS, Wahoo, Suunto, and some Amazfit — there is already no app to write, and no
code to write either: the intervals.icu connection this server already has carries
planned workouts out to all of them. For a **Wear OS** watch — Pixel, Galaxy, and
the rest — there is no route at all that does not end in an app, and today probably
not even one that does. There is no WorkoutKit on Android.

## The ask was "sync to Google Fit and let the watches read it"

That specific shape is closed, three times over.

**Google Fit is being switched off.** Its REST, Recording, Sensor, Session and BLE
APIs are supported only to the end of 2026, and new developer signups stopped on
1 May 2024 — so this deployment could not register for them even to write code with
a shelf life ([migration guide](https://developer.android.com/health-and-fitness/health-connect/migration/fit)).
Nothing should be built on it.

**Its cloud successor cannot schedule anything.** The
[Google Health API](https://developers.google.com/health/get-started) is the next
generation of the Fitbit Web API — proper OAuth, one `exercise` data type, and
writes are generally available. But
[what a write is](https://developers.google.com/health/data-types/workouts) is a
*completed* session: an interval that has already happened, its metrics summary, its
laps. There is no planned-workout resource and no scheduling endpoint. It is the
wrong half of what this server needs: it would let us post a recording back, never
send a plan out.

**Its on-device successor is not a cloud at all.** Health Connect is an Android
data store that lives on the phone, reached only by an installed app holding the
right permission; it has no server API, and it is not on the watch — Wear OS has
[Health Services](https://developer.android.com/health-and-fitness/health-services)
instead. So Health Connect is not a way to avoid an app. It is the thing an app
would write to.

## What already works, and costs nothing

**intervals.icu uploads planned workouts to Garmin, COROS, Wahoo, Suunto, Zwift and
some Amazfit models**, on the athlete's own connection, once they tick *Upload
planned workouts* under *Settings › Connections*. The workout lands in Garmin
Connect (or COROS, or Suunto as a SuuntoPlus Guide) as a scheduled workout and is on
the watch the morning it is due.

This server already pushes every workout to intervals.icu as
[the FIT file a watch would get](../integrations.md), and already reads the
completion back by webhook. So for these athletes the chain is complete today and
nobody has noticed:

```
workout-mcp ──FIT──> intervals.icu ──> Garmin / COROS / Wahoo / Suunto ──> watch
                            <──────── completion, by webhook ────────
```

**The gap is that nothing says so.** The FAQ and the onboarding interview answer
"which watch does this work with" by naming Apple and the app. The cheapest
improvement in this document is prose: an Android athlete on one of those watches
should be told to connect intervals.icu and tick the box, in the same words the FAQ
uses for the iPhone app. No code, and it covers most people who own a watch worth
planning a session for.

**Polar is the exception** among the sports watches: it syncs completed activities
out and cannot be sent a planned workout, by intervals.icu or anyone else.

**A direct Garmin adapter is still worth having** — see
[garmin-integration.md](garmin-integration.md), still parked on Garmin's developer
programme — but note what it now buys, which is less than it looks. The push half is
already carried by intervals.icu. What a direct adapter adds is an athlete who does
not want an intervals.icu account, and the completions half without a middleman.

## Wear OS: the part with no answer

This is the real question, because a Pixel Watch or a Galaxy Watch is what somebody
means by "an Android watch", and it is exactly the case
[`ios/`](../ios.md) exists for on the other platform: a watch whose sessions never
reach a platform this server can read.

### The shape exists, and appears to lead nowhere

Health Connect has **training plans** — `PlannedExerciseSessionRecord`, with blocks,
repeated steps, active and rest phases, per-step performance targets and completion
goals, behind `WRITE_PLANNED_EXERCISE`
([reference](https://developer.android.com/health-and-fitness/health-connect/features/training-plans)).
On paper it is WorkoutKit's `CustomWorkout` with different nouns, and `src/resolve.ts`
output would map onto it about as cleanly as it maps onto Apple's. It even closes the
loop the way this server wants: a completed `ExerciseSessionRecord` links back to the
planned session that it satisfied, which is the match `PlanLink` has to do by hand on
iOS.

**What is missing is the second half — somebody to read it.** Google's own model
splits the roles: one app writes the plan, a *different* app reads it, guides the
session and writes back what happened. Google documents the record and the
permission, and does not name a single app or watch on the reading side. The
evidence available says nobody is there:

- **Garmin's Health Connect support** (July 2025) is one-way, *out* of Garmin.
- **Samsung Health** synchronises exercise, heart rate and sleep with Health Connect
  and offers its own fitness programmes; nothing says it reads a third party's
  planned session, and its own workout routines are made in the app.
- **Fitbit and Pixel Watch** integrate with Health Connect on the recording side.
  Their plan-shaped features are Fitbit's own; the API that would create one
  (the Google Health API, above) has no such endpoint.
- **Runna**, which is the app that would have solved this if anyone had, syncs its
  plans to Garmin, COROS, Suunto, Fitbit and Apple Watch — and has no Wear OS app.
  Its Fitbit integration is a plan on the phone and a recording synced back, which is
  not a workout on the wrist.

So the likely truth is that writing a perfect `PlannedExerciseSessionRecord` puts the
plan somewhere no athlete can start it from. **That has to be measured before a line
of product code is written**, and it is cheap to measure: see the experiment below.

### If it did work, it is still an app

Even in the best case the record is written by an installed Android app holding
`WRITE_PLANNED_EXERCISE`, and Health Connect's health-data permissions need a
declaration to Google before the app can ship. There is no server-to-Health-Connect
path. So the honest framing of the whole Wear OS question is not *app or no app*, it
is **one app or two**.

### What one app would be

An Android phone app, the counterpart of `ios/`: sign in against the same OAuth
client, read `GET /api/workout-plans` already resolved, write the plan to Health
Connect, read the recorded `ExerciseSessionRecord` and its series back out, encode a
FIT file with Garmin's Java SDK, and post it — WorkManager where iOS uses a
background `URLSession`, and the same rules `docs/ios.md` arrived at the hard way
about what settles, what is retried and what is never guessed at.

**Two things in `ios/` do not transfer, and both are the expensive ones.** Apple
tells the app which plan a session was recorded against
(`HKWorkout.workoutPlan`); on Android that link comes free *if* the plan was read from
Health Connect by the recording app, and does not exist at all if it was not — which
throws the match back on the one-workout-of-that-sport-that-day rule, and nothing
else. And the whole reason iOS has no watch app is that Apple's Workout app executes
the plan. On Wear OS nobody does.

### What two apps would be

A Wear OS app, and it is not a sync client — it is a workout engine. `ExerciseClient`
in Health Services gives sensors, metrics and exercise goals; the intervals, the
transitions, the alerts, the mid-session screen, the tile and the ongoing-activity
notification are all ours to write and to keep working across a Wear OS device range
that does not agree on which metrics exist. `docs/ios.md` says a watch app would mean
"a second target, a second authorization, a WatchConnectivity session and a workout
engine written here — to end up with what the athlete already has". On Wear OS the
last clause is false: the athlete does not already have it. That is the whole cost of
this platform in one sentence.

**This is the largest single piece of work anyone has proposed for this project**,
and it should not start until the experiment below has been run and the intervals.icu
route has been documented and offered.

## The one experiment to run first

Perhaps a day's work, and it decides everything above.

1. A throwaway Android app that writes one `PlannedExerciseSessionRecord` — a warmup,
   `8 × (400 m hard / 200 m easy)`, a cooldown, with heart rate targets.
2. Put it on a Galaxy Watch pairing and a Pixel Watch pairing.
3. Ask one question of each: **can the athlete start that session from the watch?**
   Then the weaker one: does it appear anywhere in Samsung Health or the Google
   Health app at all?

A yes on any of them makes a phone-only Android app worth writing and this document
worth rewriting. A no on all of them settles it: for Wear OS the choice is a full
watch app or nothing, and *nothing* is a defensible answer — the intervals.icu route
already serves the watches serious enough to want an interval plan on them.

Run it again when Wear OS or Samsung ships something new; the data type is young, and
the reading side is the kind of gap an OEM closes in one release.

## What an athlete can do today with no app and no adapter

Nothing good, and it is worth saying rather than implying otherwise. `GET
/export/:date-:id.fit` gives the athlete the file. It can be dropped into a Garmin
device's `Garmin/NewFiles` over USB, and it is what intervals.icu is already sent.
Neither Samsung Health nor Fitbit imports a workout file at all. For the recording
coming back there is no route off a Wear OS watch either, short of a platform this
server can read.

## Checklist

- [ ] The FAQ and the onboarding interview name the intervals.icu route for Garmin,
      COROS, Wahoo, Suunto and Amazfit, beside the iPhone app — with the *Upload
      planned workouts* tick named, because the connection alone does not do it
- [ ] The dashboard's intervals.icu `connected_note` says the same thing, since that
      is where an athlete is standing when it matters
- [ ] Run the `PlannedExerciseSessionRecord` experiment and record the result here
- [ ] Only then: decide between an Android phone app, two apps, or neither
- [ ] Do not build on Google Fit, and do not wait for the Google Health API to learn
      how to schedule a workout
