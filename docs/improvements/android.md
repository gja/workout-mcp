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
the rest — there is no *platform* route: no cloud takes a plan, and there is no
WorkoutKit on Android, so somebody has to write the engine that executes it. The
one piece of good news in this document is that somebody already has, and it is not
us — see [Wear OS](#wear-os-no-platform-route-and-somebody-elses-app).

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

## Wear OS: no platform route, and somebody else's app

This is the real question, because a Pixel Watch or a Galaxy Watch is what somebody
means by "an Android watch", and it is exactly the case
[`ios/`](../ios.md) exists for on the other platform: a watch whose sessions never
reach a platform this server can read.

**intervals.icu does not reach it, and that is not a gap in intervals.icu.** Every
target of its *Upload planned workouts* tick is a vendor cloud that accepts a
workout — Garmin Connect, COROS, Wahoo, Suunto, Zwift. Pixel and Galaxy have no such
cloud to push to: the Google Health API takes only completed sessions, and Samsung
takes nothing from outside. There is nowhere to deliver a plan to, so nothing
delivers one.

What closes it instead is an app on the watch that fetches the plan itself.

### Somebody already wrote the watch app

[**Watchletic**](https://www.watchletic.com/intervalsicu) has run intervals.icu
workouts on an Apple Watch since 2023, and was
[ported to Wear OS in August 2026](https://forum.intervals.icu/t/intervals-icu-on-wear-os-with-watchletic/130881),
tested on a Pixel Watch 4 and a Galaxy Watch Ultra 2. It imports a planned workout
from the intervals.icu calendar, guides the intervals and targets from the wrist, and
sends the completed session back to intervals.icu — and writes it to Health Connect
on the way. Importing scheduled workouts is behind its paid tier.

That makes the chain whole for a Wear OS athlete without a line of code here, because
**it is the same chain** — this server already pushes the plan into intervals.icu and
already reads the completion back:

```
workout-mcp ──FIT──> intervals.icu ──> Watchletic ──> Pixel / Galaxy watch
                            <──── session back ────
```

So the honest answer to "what does an athlete on a Pixel Watch do" is no longer
*nothing*. It is: connect intervals.icu, and put a third-party app on the watch.
What is given up is everything Watchletic does not carry across — it reads
intervals.icu's calendar, not our plan, so any target intervals.icu renders poorly
(the whole-percentage rounding [integrations.md](../integrations.md) notes) is what
reaches the wrist.

**This should be tried before anything below is built.** One athlete, one Wear OS
watch, one planned session through the whole chain, and the answer to whether this
platform needs any of our code at all is a morning's work rather than a quarter's.

### The Health Connect shape exists, and appears to lead nowhere

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
of product code is written**, and it is cheap to measure: see the experiments below.

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
the plan. On Wear OS the system does not — only a third party does, and only for its
own source.

### What two apps would be

A Wear OS app, and it is not a sync client — it is a workout engine. `ExerciseClient`
in Health Services gives sensors, metrics and exercise goals; the intervals, the
transitions, the alerts, the mid-session screen, the tile and the ongoing-activity
notification are all ours to write and to keep working across a Wear OS device range
that does not agree on which metrics exist. `docs/ios.md` says a watch app would mean
"a second target, a second authorization, a WatchConnectivity session and a workout
engine written here — to end up with what the athlete already has". On Wear OS that
last clause is only true by somebody else's grace: what the athlete can already have
is Watchletic, bought separately. Writing this is buying it back.

**This is the largest single piece of work anyone has proposed for this project**,
and Watchletic has already done it. It should not start until the two experiments
below have been run, and probably not then.

## Without intervals.icu in the middle

Taking intervals.icu out and still refusing to execute a workout ourselves leaves
exactly one shape: **our own adapter into a vendor's cloud, and the vendor's own watch
app running the session.** That is what `src/platforms/` is already built for, and
[garmin-integration.md](garmin-integration.md) is the first one written up. What
decides it is not the code — three of these are a week's work against a documented
API — it is who will let us register.

| Vendor | Plan push exists | How to get in, today |
| --- | --- | --- |
| **Garmin** | Training API, workouts and calendar entries | **Closed.** New Connect API applications [were frozen months ago](https://the5krunner.com/2026/09/14/garmin-developer-api-access-paused/) pending a redesign of the programme, with no timeline and a queue that is not being processed |
| **COROS** | [Partner API](https://support.coros.com/hc/en-us/articles/53181766856724-Partner-API-Access) — structured workout and training plan push, multi-user OAuth, webhooks | Partner application, pitched at established platforms |
| **Suunto** | Cloud API plus the SuuntoPlus Guide Cloud, which is how a session reaches the watch | [Partner programme](https://apizone.suunto.com/faq), companies and organisations only — explicitly not personal use — approved in about two weeks |
| **Wahoo** | [Cloud API](https://cloud-api.wahooligan.com/), public and documented, structured workout plans included | Open OAuth registration, and the only one here with no gate |
| **Polar** | None | — |

**So the wall is commercial, not technical**, and the largest vendor is behind it. The
honest reading is that a direct adapter is worth writing the moment a door opens, and
that intervals.icu is currently doing for free what four partner applications would
buy — which is the argument for leaving it in the middle rather than taking it out.

**None of this touches Wear OS**, because Pixel and Galaxy have no cloud to adapt to;
the table simply has no row for them. Ruling out intervals.icu there leaves two things
and no third:

- **Watchletic already imports a `.FIT` workout file** on its paid tier, and
  `GET /export/:date-:id.fit` is exactly that file. So the chain runs today with no
  intervals.icu and no code: export, import, run it, export the session back. It is
  per-workout and manual, which is the whole objection to it.
- **Or be one of its sources.** Watchletic imports planned sessions from thirteen
  platforms — TrainingPeaks, Final Surge, intervals.icu, Nolio, Runcoach, CoachX,
  TrainAsONE, Trenara, AI Endurance, Athletica, Tredict, StrideOn, V.O2 — so the ask
  is to be the fourteenth. That is an email rather than a sprint, and it is the
  cheapest item in this document that ends with somebody else executing the workout.

The remaining idea — a thin Android phone app of ours that writes
`PlannedExerciseSessionRecord` and nothing else — is genuinely not an execution engine
and would owe nobody a subscription. It fails on the other side: nobody reads the
record. That is experiment two.

## The two experiments to run first

Between them perhaps two days, and they decide everything above.

**One: does the chain that exists already work?** Put Watchletic on a Wear OS watch,
connect it to an intervals.icu account this server pushes to, and take one planned
session out and back. What to watch for is not whether it syncs — it is what survives:
whether the intervals arrive with their targets, what the whole-percentage rounding
does to a heart rate band, and whether the session comes back paired to the event we
pushed, since that pairing is what our webhook reads. A yes is the answer to this
whole document, and the work becomes prose plus a named recommendation.

**Two: is there a platform route yet?** A throwaway Android app that writes one
`PlannedExerciseSessionRecord` — a warmup, `8 × (400 m hard / 200 m easy)`, a
cooldown, with heart rate targets — on a Galaxy Watch pairing and a Pixel Watch
pairing. One question of each: **can the athlete start that session from the watch?**
Then the weaker one: does it appear in Samsung Health or the Google Health app at all?

A yes there makes a phone-only Android app worth writing, and worth writing *whatever*
the first experiment said, because it needs no third-party subscription. A no leaves
Watchletic as the only route, which is a recommendation rather than a codebase.

Run the second one again when Wear OS or Samsung ships something new; the data type is
young, and the reading side is the kind of gap an OEM closes in one release.

## What an athlete can do with nothing installed at all

Not much, and it is worth saying rather than implying otherwise. `GET
/export/:date-:id.fit` gives the athlete the file; it can go into a Garmin device's
`Garmin/NewFiles` over USB, and it is what intervals.icu is already sent. Neither
Samsung Health nor Fitbit imports a workout file.

The **recording** direction is the softer half, and it does have a route: a session
recorded on a Galaxy Watch or a Pixel Watch reaches Strava (Samsung Health and Google
Health both sync to it), and intervals.icu reads Strava. So an athlete who will not
install Watchletic can still have what they did land where this server reads it —
they just have to have planned the session on the watch themselves.

## Checklist

- [ ] The FAQ and the onboarding interview name the intervals.icu route for Garmin,
      COROS, Wahoo, Suunto and Amazfit, beside the iPhone app — with the *Upload
      planned workouts* tick named, because the connection alone does not do it
- [ ] The dashboard's intervals.icu `connected_note` says the same thing, since that
      is where an athlete is standing when it matters
- [ ] Run the Watchletic chain end to end and record here what survived it
- [ ] Run the `PlannedExerciseSessionRecord` experiment and record the result too
- [ ] Ask Watchletic what it takes to be their fourteenth source, since that is the
      one route to a Wear OS watch with no intervals.icu and no engine of ours
- [ ] Apply to COROS and Suunto, whose doors are open, and watch for Garmin's
      reopening — the adapters are small; the applications are the long pole
- [ ] Only then: decide between an Android phone app, two apps, or neither — and
      neither is now a real answer, not a shrug
- [ ] Do not build on Google Fit, and do not wait for the Google Health API to learn
      how to schedule a workout
