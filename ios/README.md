# WorkoutsMCP for iOS

An iPhone app that carries the plan out to Apple Fitness and the recorded session back.
There is no watch app: the plan is scheduled through **WorkoutKit**, so it appears in the
Workout app on the watch the way any Fitness+ or third-party plan does, and the session
comes back through **HealthKit** like any other.

On **iOS 26** it can also record the session itself, with no watch involved at all —
HealthKit's own workout session, on the phone. What that does and deliberately does not do
is [docs/ios.md](../docs/ios.md#recording-it-on-the-phone).

It talks to [workouts-mcp.com](https://workouts-mcp.com). Pointing a build at your own
deployment is one constant in `Auth/AppSession.swift`.

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

Requires **Xcode 26 or newer** (the project uses a file-system synchronized group, so
adding a Swift file is just adding a file) and a device running **iOS 18 or newer** —
`WorkoutStep.displayName`, which is what puts a step's name on the watch, is 18.0.

The deployment target is still 18.0 and the app runs there unchanged. Xcode 26 is a
*build* requirement rather than a running one: `HKWorkoutSession` is declared watchOS-only
in earlier SDKs, so `Health/WorkoutRunner.swift` will not compile against one however the
target is set. Recording is behind `#available(iOS 26.0, *)`, so on an older phone the
button is simply not there.

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

   **Background Modes** should be listed too, with **Background fetch** and **Location
   updates** ticked — the second is what keeps a recording running with the screen off.
   Both come from `Info.plist` beside the entitlements, which holds only the two keys the
   generated plist cannot: `UIBackgroundModes` and `BGTaskSchedulerPermittedIdentifiers`.
   Everything else about the plist is still a build setting. Once installed, the app
   appears under *Settings › General › Background App Refresh*; if it does not, the
   modes did not make it into the bundle.

   The target carries **both** HealthKit purpose strings, share and update, plus
   `NSLocationWhenInUseUsageDescription`. The update string is no longer a formality: a
   session recorded on the phone is written to Health, and the string says exactly what —
   the workout, its route, and the distance, heart rate and energy measured during it.
   Location is asked for only while a recording is running, which is what the string says
   too; when-in-use with background updates on, rather than always.
3. Run it **on a real iPhone**. The simulator has no Health data worth reading and
   `WorkoutScheduler` does nothing there, so almost none of this app can be exercised in
   it. The phone needs **Developer Mode** on — *Settings › Privacy & Security › Developer
   Mode*, which asks for a restart — and iOS 18 or newer.

On first launch it asks you to sign in, then for Health and for permission to schedule
workouts. Both permission sheets are the system's, and
declining either leaves the app running with that half switched off rather than broken.

## The app icon

`WorkoutsMCP/Assets.xcassets/AppIcon.appiconset/icon-1024.png` is generated rather than
drawn: it is `public/logo-square.svg` — the same mark as the site's favicon, a warm-up, three
intervals with their recoveries and a cool-down — rasterised by `scripts/build-icons.py`.
Edit the SVG, `pip install cairosvg`, run `python3 scripts/build-icons.py` and commit what
it writes. One 1024 image is the whole set; iOS renders every other size from it, and the
file is flattened to RGB because App Store submission rejects an icon with an alpha channel.

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

One button. The deployment is a constant in `Auth/AppSession.swift` —
`workouts-mcp.com` — rather than a field to fill in: asking an athlete for a hostname
before they can sign in is a question almost none of them can answer, and the one who can
is reading this and can change the line.

The app discovers the authorization server from
`/.well-known/oauth-authorization-server`, registers itself (RFC 7591), and runs an
authorization code flow with PKCE in an `ASWebAuthenticationSession` — so the Google or
Apple sign-in happens on the server's own consent page and this app never sees a password.

It then trades the grant at `POST /api/app-token` for an ordinary `wk_` token and keeps
that in the keychain, because an OAuth access token reaches `/mcp` and not `/api/`. That
trade is behind its own `app-token` scope, which this app asks for and an MCP client does
not. The token shows up on the dashboard under *API tokens* as **WorkoutsMCP for iOS**;
revoking it there signs the app out. See
[docs/auth.md](../docs/auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).

## What it does

Three tabs.

**Planned.** At the top, where the plan stands with Apple Fitness — one line, *Synced to
Apple Fitness · 8 planned workouts · 2 minutes ago*, and tapping it syncs again. The time is
coarse on purpose: *just now*, then minutes, then hours. A sync five seconds ago and one
twenty seconds ago are the same fact. Opening the app syncs on its own when the last one was
over four hours ago, or when the plan it just read is not the one that reached the watch, so
the line is true rather than merely reassuring.

Under it, what is coming, in the order it will be run, and a tap gets the steps — the plan
as the server resolves it, repeats kept, each step with its duration and the band it is
aimed at. A **Missed** section lists anything planned, past and still not done, because
those are exactly the sessions that are still on the watch.

**Executed.** Every session there is evidence of, newest first: what Health recorded on
this phone, and what the server has already read a file for. A tick means the server has
it. A tap opens the session as the **server** read it — the totals, a row a lap with what
it was planned to be beside what it did, and how much of the lap was inside the band. A tap
on a lap opens that lap in full: heart rate average, max and min, pace, power, cadence, the
ground under it, the target with the time spent above and below, and the quarters. None of
it is computed on the phone; it is `GET /api/workouts/:date/:id/stats`, the same document
the dashboard reads. Under all of it, where Health has the session, one button: *Share .fit*,
which writes the file on the phone and opens the share sheet — with *Export to WorkoutsMCP*
in it beside AirDrop, Files and Mail.

Which planned workout a session was is shown as a fact with a link to the plan, and is not
a field to edit. It comes from the plan id the watch recorded, or from the one workout of
that sport planned for that day — and where it is neither, the session says so rather than
offering a menu to guess from.

On **iOS 26**, a running, walking or cycling workout that is not done yet also gets
**Start on this iPhone** at the foot of its steps. It asks indoors or outdoors, then runs
against the plan: which interval of how many, what it is aimed at, and — for a run — total
and interval time, pace and interval pace, distance and interval distance, cadence and heart
rate; for a ride, total and interval time, power and interval power, cadence and heart rate.
Pause, **Next interval**, and an end that saves to Health and sends it up.

Each reading is a dash until something measures it. Heart rate needs a chest strap or buds
on the standard Bluetooth profile — an iPhone has no sensor for one — and cycling power and
cadence need a sensor the phone, unlike an Apple Watch, will not pair by itself.

**Next interval** is a lap press and nothing advances on its own: the laps are what the
server matches against the steps of the plan. See
[docs/ios.md](../docs/ios.md#recording-it-on-the-phone).

**Settings.** Who is signed in, which deployment this build talks to, **Log out**, a
**Heart rate** sheet — a year of Health as the two figures zones are built from, an average
resting heart rate and an observed maximum that is the third-highest day rather than the
highest, because a wrist sensor spikes — and a **Sync log** sheet: whether Health can wake the app, when it last ran with nobody looking and
what came of it, how many sessions have gone up without anybody tapping *Export*, and the
events behind all three.

What goes to the watch is **two days back to seven days ahead**, done or not — a session
already done goes out ticked, so the days behind read as finished rather than absent. Back
as well as forward because a day missed is a session still worth doing, and each one goes
out on the day the plan gives it and no time at all — a session missed on Friday stays
Friday's in Apple Fitness rather than joining today's. Seven ahead rather than the
fourteen the server holds, because the far end of a fortnight has not settled yet. Anything this app put on the watch
that is no longer in that window — done, older than two days, or deleted upstream — comes
off.

It also works with the app shut. HealthKit launches it when a session is saved, and a
session the **watch itself** matched to a plan is built and uploaded there and then. Only
that match: the day-and-sport fallback the list uses is a guess, which is fine when the
athlete is looking at it and wrong when it files a session against a workout nobody chose.
`Health/BackgroundSync.swift`.

A wake is a request rather than a promise — Low Power Mode delays it, a force-quit stops it
until the app is opened by hand — so the same upload runs under the same rules on every
background refresh turn and on opening the app, and nothing is guessed at in either that a
wake would not guess at. Whether any of it is working is three lines in **Settings**, because
a background launch has nobody to tell.

Uploading ingests the file server-side: the stats are worked out and stored, the session
is marked done, and **the file itself is not kept**. See
[docs/stats.md](../docs/stats.md).

## Shipping it to TestFlight

Needs an **Apple Developer Program** membership. Everything below is done once except
*Every build*, which is the one that repeats.

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

### Onto the phone without Xcode

```bash
scripts/ios-install.sh                           # prints the phones it can see
scripts/ios-install.sh 00008120-XXXXXXXXXXXXXXXX # builds, installs, launches
```

Nothing about signing is passed to it. `CODE_SIGN_STYLE = Automatic`, a committed
`DEVELOPMENT_TEAM` and `-allowProvisioningUpdates` between them mean the identity comes out
of the login keychain and the profile is fetched for you.

The phone needs Developer Mode on and this Mac trusted; a wireless-paired phone works the
same way. Over SSH, unlock the keychain first — `security unlock-keychain
~/Library/Keychains/login.keychain-db` — or codesign fails with `errSecInternalComponent`
rather than saying what is wrong.

### Every build

```bash
scripts/ios-upload.sh
```

Bumps the build number, archives, and uploads to App Store Connect. Or the same three by
hand: `cd ios && agvtool next-version -all`, *Product › Archive* with *Any iOS Device
(arm64)* selected, then *Window › Organizer › Distribute App › TestFlight & App Store*.

**No App Store Connect API key is involved.** With no `-authenticationKey*` arguments,
`xcodebuild` authenticates as the Apple ID Xcode is signed in as — *Xcode › Settings ›
Accounts* — whose session lives in the login keychain, which is why a keychain prompt comes
up the first time. It is the same prompt archiving from Xcode raises, and *Always Allow*
answers it once. Signing is the keychain's too: the *Apple Distribution* identity is found
there, and nothing secret is passed on the command line or kept in this repository.

An API key is worth having only where no one is at the keyboard to answer that prompt — CI.
It is a `.p8` file plus its key id and issuer id, from *App Store Connect › Users and Access
› Integrations*, passed as `-authenticationKeyPath`, `-authenticationKeyID` and
`-authenticationKeyIssuerID`. **A `.p8` is a secret**: `*.p8` is gitignored here, and a home
directory is a better place for it than a checkout.

The build number is bumped first because App Store Connect refuses one it has already seen
for a version, and finding that out costs a whole archive. `agvtool` writes it into the
project file, so it is a change to commit. `scripts/ios-upload.sh --no-bump` re-runs an
upload that failed after the bump.

Processing takes five to thirty minutes, then the build shows up under *TestFlight*.

### Testers

**Internal** (up to 100 people who have an App Store Connect role) get it as soon as
processing finishes — no review. That is the loop you want while the app is young.

**External** (up to 10,000) needs Beta App Review first, and that review will want to sign
in. Fill in *Test Information* with a demo account on your deployment and a line saying the
sign-in is Google or Apple on the server's own page, or it comes back rejected for a
reviewer who could not get past the first screen.

### Export compliance

Every upload asks whether the app uses non-exempt encryption, and App Store Connect keeps
asking on each build until the answer is in the binary.
`INFOPLIST_KEY_ITSAppUsesNonExemptEncryption = NO` is in the build settings, so the
question is answered at build time and the *App Encryption Documentation* sheet stops
appearing.

The declaration is true of this app: it uses HTTPS through the OS, the keychain, and
SHA-256 in `Auth/OAuth.swift` and `Plan/PlanLink.swift` — a hash, not encryption. All of
that is the standard exemption. It is still a legal declaration, so if you fork this and
add encryption of your own, that line is yours to revisit.

## Where things are

```
Api/          the REST client and the shapes it decodes
Auth/         discovery, registration, PKCE, and the keychain
Fit/          a recorded session, its summary figures, and the SDK call that writes it
Health/       permission, the listing, the read that turns one into samples, recording one here, a year of heart rate, the background wake
Plan/         a resolved plan as a WorkoutKit CustomWorkout, and the id that ties them
Views/        the three tabs, a workout, a session, a lap, and signing in
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

Two things are tried, in order:

1. The **plan id** the watch recorded, looked up in the index the app wrote when it
   scheduled the workout. WorkoutKit plan ids are derived from `<date>/<id>` rather than
   allocated, so scheduling the same workout twice replaces it rather than doubling it.
2. The **one workout of that sport planned for that day**, where there is exactly one.

There is no third. A picker used to be, and what it produced when the athlete picked wrong
was a completion to undo and a page of stats about a workout that never ran. A session the
app cannot place is shown as unplaced and is not uploaded — see
[docs/ios.md](../docs/ios.md#the-id-in-the-file).

## What to check first if it does not compile

Nearly all of this is ordinary Foundation, SwiftUI, HealthKit and the FIT SDK. The part
with the most surface against a framework that has moved between releases is WorkoutKit,
and it is deliberately confined to two files — `Plan/WorkoutKitSync.swift` and
`Plan/PlanAlerts.swift`. If an initialiser has been renamed or an alert type has grown a
parameter, those are the two files to fix, and nothing else refers to WorkoutKit at all.

`Health/HealthAccess.swift` reads the plan id out of `HKWorkout.metadata` by key name,
because the constant is not in the public headers. A miss there is not a failure — the
match falls through to the day and the sport.
