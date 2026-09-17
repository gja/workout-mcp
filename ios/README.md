# WorkoutsMCP for iOS

An iPhone app that carries the plan out to Apple Fitness and the recorded session back.
There is no watch app: the plan is scheduled through **WorkoutKit**, so it appears in the
Workout app on the watch the way any Fitness+ or third-party plan does, and the session
comes back through **HealthKit** like any other.

It talks to [workouts-mcp.com](https://workouts-mcp.com) out of the box, or to your own
deployment — the sign-in screen asks which.

Why it exists and how the two halves join up is [docs/ios.md](../docs/ios.md). This file
is how to build it.

## Open source, and nothing to hide in it

This repository is open source, the app included: MIT, and the whole thing is here — the
Worker, the dashboard and this app.

**Nothing secret is checked in, here or anywhere else in the repo.** There is no API key,
no client secret and no signing identity in this project. The app registers itself with
whatever deployment you point it at ([RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591),
public client, no secret to hold), and the credential it gets back lives in the keychain
on the phone. The server's secrets are Wrangler secrets — see
[docs/deployment.md](../docs/deployment.md).

The Team ID in the project file is not an exception. It is a public identifier, carried in
the code signature of every app on the store and readable out of any of them; it signs
nothing on its own. The certificate and private key that do are not here.

## Building it

Requires **Xcode 16 or newer** (the project uses a file-system synchronized group, so
adding a Swift file is just adding a file) and a device running **iOS 18 or newer** —
`WorkoutStep.displayName`, which is what puts a step's name on the watch, is 18.0.

```bash
open ios/WorkoutsMCP.xcodeproj
```

Xcode resolves the one package dependency on first open. Then, once:

1. Nothing, if you are signing as us: the team and the bundle id are in the project.
   Otherwise set your own under the **WorkoutsMCP** target › *Signing & Capabilities*, and
   change `PRODUCT_BUNDLE_IDENTIFIER` from `com.workouts-mcp.ios` to a prefix you own.
   `DEVELOPMENT_TEAM` is committed on purpose — a Team ID is a public identifier, embedded
   in the signature of every app on the store, and committing it is what lets
   `xcodebuild archive` run with no arguments. The things that *are* secret — the `.p8`
   key, certificates, provisioning profiles — are in `.gitignore` and named under
   [Shipping it to TestFlight](#shipping-it-to-testflight).
2. Check that **HealthKit** is listed under *Signing & Capabilities*, with **Background
   Delivery** ticked under it. Both come from `WorkoutsMCP.entitlements`, which is
   deliberately outside the source folder so it is not copied into the bundle as a
   resource. Background delivery also has to be on the App ID; automatic signing adds it.
3. Run it **on a real iPhone**. The simulator has no Health data worth reading and
   `WorkoutScheduler` does nothing there, so almost none of this app can be exercised in
   it. The phone needs **Developer Mode** on — *Settings › Privacy & Security › Developer
   Mode*, which asks for a restart — and iOS 18 or newer.

On first launch it asks for the server (`workouts-mcp.com` is filled in), then for Health
and for permission to schedule workouts. Both permission sheets are the system's, and
declining either leaves the app running with that half switched off rather than broken.

## Dependencies

One, and it is the one worth having:

| | |
| --- | --- |
| [`garmin/fit-swift-sdk`](https://github.com/garmin/fit-swift-sdk) | Garmin's official FIT SDK. It owns the wire format — header, both CRCs, definition and data records, the profile's scaling and every field number — so this app only decides which messages an activity needs. It pulls in `apple/swift-collections`, and nothing else. |

Nothing else is worth a dependency here. The keychain wrapper is forty lines against
`Security`, the networking is `URLSession` and `Codable`, the UI is SwiftUI, and the
health and scheduling APIs are Apple's. A keychain wrapper, an HTTP library or a JSON
library would each add a package to audit and update in exchange for saving a file
shorter than this table.

## Signing in

The app asks for the address of the deployment and nothing else. It discovers the
authorization server from `/.well-known/oauth-authorization-server`, registers itself
(RFC 7591), and runs an authorization code flow with PKCE in an
`ASWebAuthenticationSession` — so the Google or Apple sign-in happens on the server's own
consent page and this app never sees a password.

It then trades the grant at `POST /api/app-token` for an ordinary `wk_` token and keeps
that in the keychain, because an OAuth access token reaches `/mcp` and not `/api/`. The
token shows up on the dashboard under *API tokens* as **WorkoutsMCP for iOS**; revoking
it there signs the app out. See
[docs/auth.md](../docs/auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).

A `wk_` token minted on the dashboard and pasted in works too, under *Use an API token
instead*, for a deployment where the browser round trip is not wanted.

## What it does

The home screen is three things.

**Where the plan stands.** One line — *Synced to Apple Fitness · 8 planned workouts · 2 min
ago* — and tapping it syncs again. Opening the app syncs on its own if the last one was
over half an hour ago, so the line is true rather than merely reassuring. Syncing sends
every workout still to come, and takes off the watch anything this app put there that the
plan no longer has.

**The last 7 days**, from Health: every run and ride, with the planned workout it matches
and a tick where the server already has it. Tap one for *Generate .fit*, which builds the
file on the phone, and *Upload to WorkoutsMCP*, which posts it.

**Log out.**

It also works with the app shut. HealthKit launches it when a session is saved, and a
session the **watch itself** matched to a plan is built and uploaded there and then. Only
that match: the day-and-sport fallback the list uses is a guess, which is fine when the
athlete is looking at it and wrong when it files a session against a workout nobody chose.
`Health/BackgroundSync.swift`.

Uploading ingests the file server-side: the stats are worked out and stored, the session
is marked done, and **the file itself is not kept**. See
[docs/stats.md](../docs/stats.md).

## Shipping it to TestFlight

Needs an **Apple Developer Program** membership. Everything below is done once except the
last three steps, which are every build.

### Once, on Apple's side

1. **Register the App ID.** Automatic signing does this for you the first time you build to
   a device — or do it by hand at *developer.apple.com › Certificates, Identifiers &
   Profiles › Identifiers*, bundle id `com.workouts-mcp.ios`, with **HealthKit** ticked.
2. **Create the app record** at *App Store Connect › Apps › +*. iOS, the same bundle id,
   any SKU. An upload with no app record behind it is rejected at the end of a long archive,
   so do this before the first one.
3. **Privacy policy URL**: `https://workouts-mcp.com/privacy-policy`. HealthKit apps are
   reviewed against it, and App Store Connect asks for it under *App Privacy*.

### Compile it first

Worth doing on the simulator before anything else, because the simulator needs no signing
and this is the fastest way to a clean build:

```bash
xcodebuild -project ios/WorkoutsMCP.xcodeproj -scheme WorkoutsMCP \
  -destination 'generic/platform=iOS Simulator' build
```

`generic/` rather than a named device on purpose: naming one means `OS:latest` too, and
that fails on a machine whose newest installed runtime is older than the newest that
exists. `xcodebuild -showdestinations -project ios/WorkoutsMCP.xcodeproj -scheme WorkoutsMCP`
lists what this machine actually has.

Then run it on a real iPhone (⌘R with the phone selected), which is the only place
HealthKit has data and `WorkoutScheduler` does anything.

### Every build

1. **Bump the build number.** App Store Connect refuses a build number it has already seen
   for a version. `CURRENT_PROJECT_VERSION` is the build, `MARKETING_VERSION` the version:

   ```bash
   cd ios && agvtool next-version -all
   ```

2. **Archive.** In Xcode, choose *Any iOS Device (arm64)* and *Product › Archive*. Or:

   ```bash
   xcodebuild -project ios/WorkoutsMCP.xcodeproj -scheme WorkoutsMCP \
     -destination 'generic/platform=iOS' \
     -archivePath build/WorkoutsMCP.xcarchive \
     -allowProvisioningUpdates archive
   ```

3. **Upload.** *Window › Organizer*, select the archive, *Distribute App › TestFlight &
   App Store › Upload*. From the command line it is two steps and an
   [App Store Connect API key](https://appstoreconnect.apple.com/access/integrations/api):

   ```bash
   xcodebuild -exportArchive \
     -archivePath build/WorkoutsMCP.xcarchive \
     -exportOptionsPlist ios/ExportOptions.plist \
     -exportPath build/export \
     -allowProvisioningUpdates \
     -authenticationKeyPath "$PWD/AuthKey_XXXXXXXXXX.p8" \
     -authenticationKeyID XXXXXXXXXX \
     -authenticationKeyIssuerID 00000000-0000-0000-0000-000000000000
   ```

   with an `ExportOptions.plist` of `method` = `app-store-connect`, `destination` = `upload`
   and your `teamID`. **That `.p8` key is a secret: keep it outside this repository.**

Processing takes five to thirty minutes, then the build shows up under *TestFlight*.

### Testers

**Internal** (up to 100 people who have an App Store Connect role) get it as soon as
processing finishes — no review. That is the loop you want while the app is young.

**External** (up to 10,000) needs Beta App Review first, and that review will want to sign
in. Fill in *Test Information* with a demo account on your deployment and a line saying the
sign-in is Google or Apple on the server's own page, or it comes back rejected for a
reviewer who could not get past the first screen.

### Export compliance

Every upload asks whether the app uses non-exempt encryption. This app only uses HTTPS and
the keychain, which is the standard exemption, so the answer is no. Adding
`INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO` to the build settings answers it once
rather than on every build — left out of the project deliberately, because it is a legal
declaration and it should be the shipper who makes it.

## Where things are

```
Api/          the REST client and the shapes it decodes
Auth/         discovery, registration, PKCE, and the keychain
Fit/          a recorded session, its summary figures, and the SDK call that writes it
Health/       permission, the listing, the read that turns one into samples, the background wake
Plan/         a resolved plan as a WorkoutKit CustomWorkout, and the id that ties them
Views/        the home screen, a session, and signing in
```

### What goes in the file

`Health/SessionReader.swift` walks a one-second timeline and fills each second from
whichever HealthKit series covers it, so a `record` message carries everything the watch
had:

| | |
| --- | --- |
| Position | latitude, longitude and the fix's accuracy, from the workout route |
| Elevation | altitude, plus the climb rate and grade derived across five seconds of it |
| Pace | speed from the sport's own series, from the route, or from the distance travelled |
| Distance | cumulative metres, as FIT wants it |
| Heart rate | beats a minute |
| Power | running or cycling watts |
| Cadence | crank rpm, or steps a minute turned into strides — with the half-stride in `fractional_cadence` rather than rounded off |
| Running dynamics | vertical oscillation, ground contact time, stride length |
| Respiration | breaths a minute |
| Energy | cumulative kilocalories |

The `session` and each `lap` then carry the summary of all of it: totals, averages, maxima
and minima, bounding box, start and end position, work in joules, and normalized power.
Elevation gain and normalized power are computed the way the **server** computes them when
a file leaves them out — a 3 m noise gate, and Coggan's rolling 30-second average — so a
file this app writes and one it does not read the same. See [docs/stats.md](../docs/stats.md).

A channel the athlete did not record is **absent**, never zero: a zero heart rate would be
read downstream as a measurement.

### The id in the file

The workout id travels as a **developer field** on the `session` message, named
`workout_mcp_id` and holding `<date>/<id>`. That is the FIT spec's own extension point, so
a decoder that does not know about it skips it and one that does can read it back. The
upload does not depend on it — the route names the workout — but a file shared anywhere
else still says what it was for.

### Matching a session back to its plan

Three things are tried, in order:

1. The **plan id** the watch recorded, looked up in the index the app wrote when it
   scheduled the workout. WorkoutKit plan ids are derived from `<date>/<id>` rather than
   allocated, so scheduling the same workout twice replaces it rather than doubling it.
2. The **one workout of that sport planned for that day**, where there is exactly one.
3. The athlete, from a picker, which is always there and always wins.

## What to check first if it does not compile

Nearly all of this is ordinary Foundation, SwiftUI, HealthKit and the FIT SDK. The part
with the most surface against a framework that has moved between releases is WorkoutKit,
and it is deliberately confined to two files — `Plan/WorkoutKitSync.swift` and
`Plan/PlanAlerts.swift`. If an initialiser has been renamed or an alert type has grown a
parameter, those are the two files to fix, and nothing else refers to WorkoutKit at all.

`Health/HealthAccess.swift` reads the plan id out of `HKWorkout.metadata` by key name,
because the constant is not in the public headers. A miss there is not a failure — the
match falls through to the day and the sport, and then to the picker.
