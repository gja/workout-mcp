# WorkoutsMCP for iOS

An iPhone app that carries the plan out to Apple Fitness and the recorded session back.
There is no watch app: the plan is scheduled through **WorkoutKit**, so it appears in the
Workout app on the watch the way any Fitness+ or third-party plan does, and the session
comes back through **HealthKit** like any other.

Why it exists and how the two halves join up is [docs/ios.md](../docs/ios.md). This file
is how to build it.

## Building it

Requires **Xcode 16 or newer** (the project uses a file-system synchronized group, so
adding a Swift file is just adding a file) and a device running **iOS 17 or newer**.

```bash
open ios/WorkoutsMCP.xcodeproj
```

Then, once:

1. Select the **WorkoutsMCP** target › *Signing & Capabilities*, and set your team.
   Change `PRODUCT_BUNDLE_IDENTIFIER` from `com.example.WorkoutsMCP` to something under
   a prefix you own.
2. Check that **HealthKit** is listed under *Signing & Capabilities*. It comes from
   `WorkoutsMCP.entitlements`, which is deliberately outside the source folder so it is
   not copied into the bundle as a resource.
3. Run it **on a real iPhone**. The simulator has no Health data worth reading and
   `WorkoutScheduler` does nothing there, so almost none of this app can be exercised in
   it.

There is no Swift package to fetch: everything is a system framework.

## Signing in

The app asks for the address of your deployment and nothing else. It discovers the
authorization server from `/.well-known/oauth-authorization-server`, registers itself
(RFC 7591), and runs an authorization code flow with PKCE in an
`ASWebAuthenticationSession` — so the Google or Apple sign-in happens on your server's
own consent page and this app never sees a password.

It then trades the grant at `POST /api/app-token` for an ordinary `wk_` token and keeps
that in the keychain, because an OAuth access token reaches `/mcp` and not `/api/`. The
token shows up on the dashboard under *API tokens* as **WorkoutsMCP for iOS**; revoking
it there signs the app out. See
[docs/auth.md](../docs/auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).

A `wk_` token minted on the dashboard and pasted in works too, under *Use an API token
instead*, for a deployment where the browser round trip is not wanted.

## What it does

| | |
| --- | --- |
| **Planned** | The plan from `GET /api/workouts`. Swipe right on one to send it to Apple Fitness, left to take it off again, or use *Send all* for everything still to come. |
| **Recorded in Health** | Runs and rides from the last week. Tap one for *Generate .fit*, which builds the file on the phone, and *Upload to WorkoutsMCP*, which posts it. |

Uploading ingests the file server-side: the stats are worked out and stored, the session
is marked done, and **the file itself is not kept**. See
[docs/stats.md](../docs/stats.md).

## Where things are

```
Api/          the REST client and the shapes it decodes
Auth/         discovery, registration, PKCE, and the keychain
Fit/          the FIT encoder, and a recorded session as an activity file
Health/       permission, the workout listing, and the read that turns one into samples
Plan/         a resolved plan as a WorkoutKit CustomWorkout, and the id that ties them
Views/        the home screen, a session, and signing in
```

### The FIT encoder

`Fit/FitWriter.swift` writes definition and data records, the 14-byte header and both
CRCs; `Fit/ActivityFit.swift` decides which messages an activity file needs. Every field
number, scale and enum value in it was read out of the profile that ships with
`@garmin/fitsdk` — the same decoder the server reads the file back with — rather than
remembered, and the byte layout was prototyped in JavaScript and round-tripped through
that decoder and through `statsFrom` before being written here.

The workout id travels in the file as a **developer field** on the `session` message,
named `workout_mcp_id` and holding `<date>/<id>`. That is the spec's own way to add a
field, so a decoder that does not know about it skips it and one that does can read it
back. The upload does not depend on it — the route names the workout — but a file shared
anywhere else still says what it was for.

### Matching a session back to its plan

Three things are tried, in order:

1. The **plan id** the watch recorded, looked up in the index the app wrote when it
   scheduled the workout. WorkoutKit plan ids are derived from `<date>/<id>` rather than
   allocated, so scheduling the same workout twice replaces it rather than doubling it.
2. The **one workout of that sport planned for that day**, where there is exactly one.
3. The athlete, from a picker, which is always there and always wins.

## What to check first if it does not compile

Nearly all of this is ordinary Foundation, SwiftUI and HealthKit. The part with the most
surface against a framework that has moved between releases is WorkoutKit, and it is
deliberately confined to two files — `Plan/WorkoutKitSync.swift` and
`Plan/PlanAlerts.swift`. If an initialiser has been renamed or an alert type has grown a
parameter, those are the two files to fix, and nothing else refers to WorkoutKit at all.

`Health/HealthAccess.swift` reads the plan id out of `HKWorkout.metadata` by key name,
because the constant is not in the public headers. A miss there is not a failure — the
match falls through to the day and the sport, and then to the picker.
