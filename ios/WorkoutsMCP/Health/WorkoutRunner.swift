// A planned session recorded on the phone itself, for an athlete whose watch is not an
// Apple Watch or is on the charger. HealthKit's own workout session — the one watchOS has
// always had, and iPhone has had since iOS 26 — so what this saves is an ordinary
// `HKWorkout` and the way back to the server is the one every other session already takes.
//
// It is started **against a plan**, and it conducts one: a step measured in time or in
// metres advances itself when it is done, and the athlete is told — the interval and its
// band as it opens, five seconds before a timed one closes, and when a reading has left the
// band or come back to it. The lap button is still there, and is the only way through a step
// that ends when the athlete says it does. See "Recording it on the phone" in docs/ios.md.

// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import CoreLocation
import Foundation
import HealthKit

/// Where the **app** has got to with a recording — not where the recording has got to.
/// Running and paused are the session's own business and are not repeated here: a screen
/// that keeps its own copy of them ends up disagreeing with the session, and what that
/// produced was a pause button over an already-paused session answering *unable to perform
/// 'pause' from current state 'Paused'*. See `WorkoutRunner.sessionState`.
///
/// `failed` carries what to put in front of the athlete, because every way this can go wrong
/// happens while they are standing outside waiting.
enum RunPhase: Equatable {
    case starting
    case live
    case saving
    case saved
    case failed(String)
}

@available(iOS 26.0, *)
@MainActor
final class WorkoutRunner: NSObject, ObservableObject {
    @Published private(set) var phase: RunPhase = .starting

    /// The session's own state, mirrored from its delegate so SwiftUI can see it — and
    /// **written nowhere else**. Every control asks what the session may do rather than what
    /// the screen last heard, and every screen follows from the callback that says it
    /// happened. A button that changes the screen and then tells the session is a button that
    /// can be pressed twice before the session has been told once.
    @Published private(set) var sessionState: HKWorkoutSessionState = .notStarted

    /// Paused is the session's answer, not a phase of this app's.
    var isPaused: Bool { sessionState == .paused }

    /// Moving figures, and every one of them optional. A heart rate of zero, a pace of zero
    /// and a cadence of zero are what an absent strap, a cold GPS fix and a phone on a table
    /// look like, and the screen has to be able to say "nothing yet" rather than claim a
    /// measurement — the same rule the FIT file is written under. See docs/stats.md.
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var intervalElapsed: TimeInterval = 0
    @Published private(set) var metres: Double?
    @Published private(set) var intervalMetres: Double?
    @Published private(set) var speedMS: Double?
    @Published private(set) var intervalPaceSKm: Double?
    @Published private(set) var heartRate: Double?
    @Published private(set) var cadence: Double?
    @Published private(set) var power: Double?
    @Published private(set) var intervalPower: Double?

    /// Which interval the athlete is on, counting from zero, and what it is. It runs past the
    /// end of the plan rather than stopping there: a lap press is the athlete's, and a
    /// seventeenth interval on a plan with sixteen is a fact to record, not one to refuse.
    @Published private(set) var interval = 0

    /// Absent only for a session picked up off the system with nothing in the plan to tie it
    /// to — it recorded, it has to be endable, and it does not need a name to be either.
    let workout: PlannedWorkout?
    let steps: [RunStep]

    var step: RunStep? { steps.indices.contains(interval) ? steps[interval] : nil }

    /// Whether there is a session to act on, which is what every control on the screen is
    /// enabled by and what decides whether a second `begin` would be starting anything.
    var isRecording: Bool { phase == .live }

    /// Everything that follows from the session's own configuration, and therefore not `let`:
    /// a recovered session brings its own, and reading a ride with a run's quantity types
    /// would show an empty screen over a recording that is going perfectly well.
    private(set) var indoors: Bool
    private(set) var isCycling: Bool
    private var configuration: HKWorkoutConfiguration
    private var distanceType: HKQuantityType

    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var route: HKWorkoutRouteBuilder?
    private let locations = CLLocationManager()
    private var clock: Task<Void, Never>?
    private var waiting: CheckedContinuation<Void, Never>?
    private var waitingFor: HKWorkoutSessionState?

    private let voice = RunVoice()
    /// The bands of the step being run, and what has already been said about each. Rebuilt
    /// every interval: a watch remembers which side it last announced, and that is about one
    /// interval and nothing else.
    private var watches: [TargetWatch] = []
    /// Once an interval, and only for a step that ends on a clock.
    private var countedDown = false

    /// How long before a timed step closes the athlete is told. Long enough to pick the pace
    /// up into the next one, short enough not to be a second countdown of its own.
    private static let warning = 5.0

    /// Where this interval started, in the figures that only ever count up. Everything the
    /// screen says about the interval is the difference between now and one of these.
    private var intervalFromElapsed: TimeInterval = 0
    /// Nil until distance is known *within this interval*. Zero would do instead, and did,
    /// and it is wrong in the one direction that matters: a step opening before HealthKit has
    /// handed any distance over would count the whole session's metres as its own and find a
    /// 150 m step due the instant the first reading arrived.
    private var intervalFromMetres: Double?
    /// Whether an activity of this app's has been begun, so there is one to close at the end.
    private var cutting = false
    private var powerSum = 0.0
    private var powerReadings = 0

    /// Cumulative steps, read once a second and kept for as long as a cadence is taken over.
    /// HealthKit counts steps; it does not count them per minute, and a cadence off one
    /// second of them would swing by twenty with every stride landing either side of a tick.
    private var stepCounts: [(at: Date, steps: Double)] = []
    private static let cadenceWindow = 15.0
    private static let cadenceFloor = 5.0

    /// When the last usable fix arrived, so a pace can be dropped once it stops being one,
    /// and the speeds of the last few of them. One fix's speed swings by minutes a kilometre
    /// between strides — a quarter of a test walk read 10:27/km and the next 22:38 — and a
    /// figure nobody can read while moving is not worth showing.
    private var fixedAt: Date?
    private var fixes: [(at: Date, speed: Double)] = []
    private static let paceWindow = 10.0
    private static let staleFix = 10.0

    /// Cumulative distance, kept for as long as a speed is taken over it. Wider than the
    /// cadence's window because the pedometer hands distance over in lumps rather than
    /// steadily, and a narrow window of that is a pace that reads zero and then sprints.
    private var distances: [(at: Date, metres: Double)] = []
    private static let speedWindow = 20.0
    private static let speedFloor = 8.0

    /// A fix this far out is the phone guessing, and a guess this app records is a guess the
    /// server will compute a pace from. Apple's own advice for a workout route.
    private static let usableAccuracy = 50.0

    /// Below a crawl, a GPS speed is the fix moving rather than the athlete. Under this, the
    /// screen says nothing instead of counting out a pace nobody is running.
    private static let movingMS = 0.5

    /// An interval pace over the first few strides of it is the rounding on one GPS fix. Far
    /// enough in, it is a pace.
    private static let paceableMetres = 20.0

    /// How long to wait for the session to reach a state before going on without it. A wait
    /// with no limit loses the recording exactly as completely as not waiting at all.
    private static let stateLimit = 10.0

    /// Long enough for the delegate to have reported a lap that could not be cut. It is a
    /// settle, not a proof: nothing acknowledges `beginNewActivity` on the way out.
    private static let settle = 0.25

    /// `recovered` is a session the app was handed on opening rather than one this screen is
    /// about to start. Everything about it — sport, indoors, the laps it has already cut —
    /// comes off the session itself, so what is passed here is only what there is to show.
    private let recovered: HKWorkoutSession?

    init(workout: PlannedWorkout?, steps: [RunStep], indoors: Bool, recovered: HKWorkoutSession? = nil) {
        self.workout = workout
        self.steps = steps
        self.indoors = indoors
        self.recovered = recovered

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = workout.map { Sports.activityType($0.sport) } ?? .other
        configuration.locationType = indoors ? .indoor : .outdoor
        self.configuration = configuration
        isCycling = configuration.activityType == .cycling
        distanceType = isCycling ? HKQuantityType(.distanceCycling) : HKQuantityType(.distanceWalkingRunning)

        super.init()
    }

    // --- Starting, and picking up one that was lost ---------------------------------------

    /// One tap, and the first thing it does is look for a session already running.
    ///
    /// HealthKit keeps a session alive across a force-quit — it belongs to the system, not to
    /// this process — and refuses a second one while it holds it. Without the recovery the
    /// athlete who swipes the app away mid-run comes back to a start button that fails and a
    /// recording nothing can end.
    /// Whether it is recording when this returns. The caller waits for it before putting the
    /// screen up: a screen over a session that never started is what the athlete cannot tell
    /// from one that did, and they find out a minute in, outdoors.
    @discardableResult
    func begin() async -> Bool {
        if let recovered {
            resume(recovered)
            // Over rather than going: saving it is the only thing left, and the caller is
            // told it is not recording so no screen goes up over a session that has ended.
            if case .saving = phase { await end() }
            return isRecording
        }
        if await resumeRecovered() { return true }

        guard let workout else {
            phase = .failed("There is no workout to start.")
            return false
        }

        do {
            let session = try HKWorkoutSession(healthStore: HealthAccess.store, configuration: configuration)
            adopt(session)

            let at = Date()
            session.startActivity(with: at)
            try await builder?.beginCollection(at: at)
            // Written at the start rather than at the end: it is the one thing that says
            // which planned workout this was, and the end is where a recording is most
            // likely to be interrupted.
            try await builder?.addMetadata([
                HealthAccess.workoutKeyMetadata: workout.key,
                HKMetadataKeyIndoorWorkout: indoors,
            ])

            // A lap cannot be cut in a session that is not running yet, and `startActivity`
            // returning is not the session running — the delegate's word for it is.
            await wait(for: .running)
            guard session.state == .running else { return abandon("Health did not start the session.") }

            // Written down before a step is counted, so a session picked up in another
            // process has its plan without going back to the network for it.
            Underway.remember(key: workout.key, steps: steps)

            openInterval(at: Date())
            // Nothing acknowledges `beginNewActivity`; a lap it could not cut arrives as the
            // session failing, on the delegate's own turn rather than this one.
            try? await Task.sleep(for: .seconds(Self.settle))
            if case .failed(let why) = phase { return abandon(why) }

            follow()
            phase = .live
            return true
        } catch {
            return abandon(error.localizedDescription)
        }
    }

    /// A start that got far enough to be recording and no further. The session is ended
    /// rather than left: one nothing ends keeps recording with no screen left that can stop
    /// it, which is the state this whole screen exists to make impossible.
    private func abandon(_ why: String) -> Bool {
        session?.end()
        session = nil
        stop()
        phase = .failed(why)
        return false
    }

    /// A recovered session keeps the workout it was started for, because the key was written
    /// into it then: what this screen says above the clock can be the wrong name, and what is
    /// saved cannot be the wrong workout. The interval count starts again from one — it lived
    /// in the process that went away — and the laps already cut are still in the session.
    private func resumeRecovered() async -> Bool {
        guard let found = await Self.active() else { return false }
        resume(found)
        return true
    }

    /// What the app is still holding, if anything — asked on opening as well as here, because
    /// a recording nobody can find is a recording nobody can stop. See `WorkoutRecovery`.
    static func active() async -> HKWorkoutSession? {
        try? await HealthAccess.store.recoverActiveWorkoutSession()
    }

    /// The workout a running session was started for, read back out of the metadata it was
    /// given at the start. Which is why it is written then and not at the end.
    static func workoutKey(of session: HKWorkoutSession) -> String? {
        session.associatedWorkoutBuilder().metadata[HealthAccess.workoutKeyMetadata] as? String
    }

    private func resume(_ recovered: HKWorkoutSession) {
        adopt(recovered)
        // Read before rebasing, or the interval counts from zero while the session is
        // already minutes in — and the first tick finds a 60-second step long since due and
        // advances it. That is what put a recovered session straight onto interval two.
        read(onTick: false)
        rebase()

        // `recoverActiveWorkoutSession` hands back a session that has **ended** as readily as
        // one that is running, and reading anything but `.paused` as running is what put a
        // pause button over a finished recording: tapping it answered "unable to perform
        // 'pause' from current state 'Ended'". There is nothing to resume in one that is
        // over; there is only the saving it never got.
        switch recovered.state {
        case .ended, .stopped:
            phase = .saving
        default:
            follow()
            phase = .live
        }
    }

    /// The wiring both ways in have to do, and the one place the session's configuration is
    /// read rather than assumed: a recovered ride is a ride whatever screen picked it up. The
    /// builder comes off the session rather than being made beside it, so a recovered session
    /// brings its own collected samples with it.
    private func adopt(_ session: HKWorkoutSession) {
        configuration = session.workoutConfiguration
        indoors = configuration.locationType == .indoor
        isCycling = configuration.activityType == .cycling
        distanceType = isCycling ? HKQuantityType(.distanceCycling) : HKQuantityType(.distanceWalkingRunning)

        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = source()
        session.delegate = self
        builder.delegate = self

        self.session = session
        self.builder = builder
        // Seeded here because adopting a session raises no callback: after this the delegate
        // is the only thing that writes it.
        sessionState = session.state
        if !indoors {
            route = HKWorkoutRouteBuilder(healthStore: HealthAccess.store, device: nil)
            startLocating()
        }
    }

    /// Cadence and power are **not** in what a live data source collects on its own, and a
    /// type nobody collects is a reading that is a dash for ever and a channel the FIT file
    /// leaves empty. Asked for by name, therefore, and asked for whether or not a sensor for
    /// them is paired — collecting a type nothing writes costs nothing.
    private func source() -> HKLiveWorkoutDataSource {
        let source = HKLiveWorkoutDataSource(
            healthStore: HealthAccess.store, workoutConfiguration: configuration
        )
        source.enableCollection(for: HKQuantityType(isCycling ? .cyclingCadence : .stepCount), predicate: nil)
        if isCycling { source.enableCollection(for: HKQuantityType(.cyclingPower), predicate: nil) }
        return source
    }

    // --- While it runs ---------------------------------------------------------------------

    /// One button, and what it does is the session's to decide. Asking a paused session to
    /// pause is refused — *unable to perform 'pause' from current state 'Paused'* — and that
    /// is exactly what a second tap did while the first was still on its way to the delegate,
    /// because the screen was reading its own copy of the state rather than the session's.
    func togglePause() {
        guard let session else { return }
        switch session.state {
        case .running: session.pause()
        case .paused: session.resume()
        default: break
        }
    }

    /// The lap press, and the reason the plan is here at all.
    ///
    /// It cuts an **`HKWorkoutActivity`**, which is what makes the saved workout a session of
    /// laps rather than one long one: `SessionReader` reads those activities back, the FIT
    /// file carries a `lap` message each, and the server matches them against the steps the
    /// plan was written with. A recording with no lap presses is one lap and says so.
    ///
    /// Nothing does this on the athlete's behalf. A step that says "4 minutes" is counted out
    /// on the screen and left there; advancing it on a timer is the workout engine docs/ios.md
    /// declines to write, and it would be wrong the first time somebody stopped at a junction.
    func nextInterval() {
        // Running only, and the session is asked rather than the screen. `beginNewActivity`
        // on a paused session is the same shape of refusal as `endCurrentActivity` on one
        // with nothing open, and that one failed a session.
        guard session?.state == .running else { return }

        interval += 1
        openInterval(at: Date())
    }

    /// Beginning an activity ends whichever one is open, the session's own primary activity
    /// included, so nothing is closed here first. Closing it here is what broke the first
    /// session ever recorded: `endCurrentActivity` with nothing of ours open failed the
    /// session, and a failed session neither advances nor shows its buttons, while HealthKit
    /// went on recording behind it.
    private func openInterval(at: Date) {
        session?.beginNewActivity(configuration: configuration, date: at, metadata: nil)
        cutting = true

        rebase()
        voice.say(step?.spoken ?? "Workout complete.")
    }

    /// What this interval counts from. Separate from opening one because a recovered session
    /// needs the counting reset without a lap being cut: the laps it already has are in the
    /// session, and one more at the moment somebody reopened the app is not a lap they ran.
    private func rebase() {
        intervalFromElapsed = elapsed
        intervalFromMetres = metres
        powerSum = 0
        powerReadings = 0
        intervalElapsed = 0
        intervalMetres = nil
        intervalPaceSKm = nil
        intervalPower = nil

        watches = (step?.targets ?? []).compactMap(TargetWatch.init)
        countedDown = false
    }

    /// Ending is four things in order, the last of which can fail without costing the session:
    /// the open lap is closed, the session is stopped and **waited for**, the builder is
    /// closed and saved, and the route is attached to the workout that came back.
    ///
    /// The wait is the part that is not obvious. `endCollection` on a session that has not
    /// reached `.ended` is refused, and a refusal here is the whole recording — so the
    /// delegate's own word for it is waited on, with a limit, because a wait that never
    /// returns loses the session exactly as completely. A route that will not attach is a
    /// session with no line on the map, which is worth less than the session.
    func end() async {
        phase = .saving
        stop()

        guard let session, let builder else {
            SyncLog.record(.upload, "ending: nothing to end — session \(self.session == nil ? "gone" : "held")")
            phase = .failed("Nothing was recording.")
            return
        }

        // Each step written down, because the end of a session is where one is lost and the
        // athlete reads the reason once on a screen they then close. One walk's worth of
        // this says which call refused rather than leaving it to be inferred.
        SyncLog.record(.upload, "ending: state \(session.state.rawValue), cut \(cutting)")

        // Not a guarantee. `wait(for:)` gives up after its limit and lets this go on rather
        // than hanging for ever, so the state is read again rather than assumed — and what
        // follows is attempted either way, since a save that might work beats one that is
        // not tried.
        // A session that has already ended is not ended again: "unable to end a workout that
        // is not currently active" is what that costs, and what is left to do — closing the
        // builder and saving — is the same either way.
        if session.state == .running || session.state == .paused {
            let at = Date()
            // Only what this app opened. `session.end()` closes whatever is still open anyway.
            if cutting { session.endCurrentActivity(on: at) }
            session.end()
            await wait(for: .ended)
            SyncLog.record(.upload, "ending: session now \(session.state.rawValue)")
        }

        // **After** the session has ended, not before it. `session.end()` closes the open
        // activity at the moment HealthKit ends the session, which is later than any moment
        // captured before the wait — and a collection ended before an activity it contains is
        // refused with "workout activity did not occur during this workout", which is a whole
        // recording lost to a timestamp read a second too early.
        let closed = Date()

        do {
            // Its failure is not reported: a collection already ended refuses a second
            // ending, and what decides whether the session survives is `finishWorkout`.
            try? await builder.endCollection(at: closed)
            guard let saved = try await builder.finishWorkout() else {
                SyncLog.record(.upload, "ending: Health returned no workout")
                phase = .failed("Health did not save the session.")
                return
            }
            SyncLog.record(.upload, "ending: saved \(saved.uuid)")
            if let route { _ = try? await route.finishRoute(with: saved, metadata: nil) }
            // Only once it is in Health: a session that could not be saved is one whose plan
            // the next attempt still needs.
            Underway.clear()
            phase = .saved
        } catch {
            // Written down, because the one failure that matters most is the one an athlete
            // reads once on a screen they then close. See Settings › Sync log.
            SyncLog.record(.upload, "could not save the session: \(SyncLog.describe(error))")
            phase = .failed(error.localizedDescription)
        }
    }

    /// `endCollection` on a session that has not reached `.ended` is refused, and a lap cut
    /// in one that has not reached `.running` is refused too, so both are waited for rather
    /// than assumed from the call that asked for them.
    private func wait(for state: HKWorkoutSessionState) async {
        guard let session, session.state != state else { return }

        waitingFor = state
        let limit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.stateLimit))
            self?.stopWaiting()
        }
        await withCheckedContinuation { waiting = $0 }
        limit.cancel()
    }

    /// Resumed from one of three places — the delegate reaching the state, the delegate
    /// failing, or the limit running out — and the continuation is cleared first so none of
    /// them can resume it twice.
    private func stopWaiting() {
        let held = waiting
        waiting = nil
        waitingFor = nil
        held?.resume()
    }

    /// Everything of this object's that outlives the screen: the clock would tick for the
    /// life of the process, and location updates would keep the arrow in the status bar.
    func stop() {
        clock?.cancel()
        clock = nil
        stopLocating()
        voice.stop()
    }

    /// Elapsed comes off the builder rather than off a start date this class keeps, because
    /// the builder is the one that knows what was paused.
    private func follow() {
        guard clock == nil else { return }
        read(onTick: true)

        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                self?.read(onTick: true)
            }
        }
    }

    /// `onTick` is what separates the figures that are simply read from the one that is
    /// accumulated: the builder's delegate fires whenever samples land, which is neither
    /// once a second nor at any rate worth averaging against.
    private func read(onTick: Bool) {
        guard let builder else { return }

        elapsed = builder.elapsedTime
        intervalElapsed = max(0, elapsed - intervalFromElapsed)

        metres = builder.statistics(for: distanceType)?.sumQuantity()?.doubleValue(for: .meter())
        // The baseline is taken at the first reading of the interval rather than at its
        // opening, because there may not have been one to take then.
        if intervalFromMetres == nil { intervalFromMetres = metres }
        intervalMetres = metres.flatMap { now in intervalFromMetres.map { max(0, now - $0) } }
        intervalPaceSKm = intervalMetres.flatMap { metres in
            metres >= Self.paceableMetres && intervalElapsed > 0
                ? intervalElapsed / (metres / 1000)
                : nil
        }

        heartRate = latest(HKQuantityType(.heartRate), in: .count().unitDivided(by: .minute()))
        power = latest(HKQuantityType(isCycling ? .cyclingPower : .runningPower), in: .watt())
        let now = Date()
        if onTick {
            averagePower()
            readCadence(at: now)
            readSpeed(at: now)
        }

        // Judged only on the tick, and only once every figure above has been read: a drift
        // counted at the rate samples happen to land is a drift counted at no rate at all,
        // and the advance has to see the distance this second's fix brought in.
        guard onTick, sessionState == .running else { return }
        advanceIfDue()
        countDown()
        callOutDrift()
    }

    /// The step ends itself where the plan gave it an end. An open step never does — "until
    /// lap press" is what it means — and neither does a lap press past the end of the plan,
    /// which has no step behind it to be due.
    private func advanceIfDue() {
        guard let step else { return }

        if let seconds = step.seconds, intervalElapsed >= seconds { nextInterval(); return }
        if let metres = step.metres, let run = intervalMetres, run >= metres { nextInterval() }
    }

    /// Only for a step that ends on a clock. A step measured in metres has no five seconds
    /// left — how long is left of it is a pace this app would be guessing at.
    private func countDown() {
        guard !countedDown, let seconds = step?.seconds else { return }

        let left = seconds - intervalElapsed
        guard left > 0, left <= Self.warning else { return }
        countedDown = true
        voice.say("5 seconds left")
    }

    private func callOutDrift() {
        for index in watches.indices {
            let reading: Double?
            switch watches[index].metric {
            case .speed: reading = speedMS
            case .heartRate: reading = heartRate
            case .power: reading = power
            case .cadence: reading = cadence
            }
            if let said = watches[index].read(reading) { voice.say(said) }
        }
    }

    private func latest(_ type: HKQuantityType, in unit: HKUnit) -> Double? {
        builder?.statistics(for: type)?.mostRecentQuantity()?.doubleValue(for: unit)
    }

    /// Averaged over this interval's own readings, one a second, because the builder's average
    /// is the whole session's and does not come apart again at a lap. A meter emits about once
    /// a second, so the two agree closely enough for a number to pedal at — and the averages
    /// in the **file** are HealthKit's own samples, read back by `SessionReader`, not these.
    private func averagePower() {
        guard let watts = power else { return }
        powerSum += watts
        powerReadings += 1
        intervalPower = powerSum / Double(powerReadings)
    }

    /// Cycling cadence is measured and handed over; running cadence is not. HealthKit counts
    /// steps, so a runner's is the steps of the last few seconds over those seconds, which is
    /// also why it is absent for the first few: a cadence needs a window to be taken over.
    private func readCadence(at now: Date) {
        if isCycling {
            cadence = latest(HKQuantityType(.cyclingCadence), in: .count().unitDivided(by: .minute()))
            return
        }

        guard let steps = builder?.statistics(for: HKQuantityType(.stepCount))?
            .sumQuantity()?.doubleValue(for: .count()) else { return }

        stepCounts.append((now, steps))
        stepCounts.removeAll { now.timeIntervalSince($0.at) > Self.cadenceWindow }

        guard let oldest = stepCounts.first else { return }
        let span = now.timeIntervalSince(oldest.at)
        cadence = span >= Self.cadenceFloor ? (steps - oldest.steps) / span * 60 : nil
    }

    /// A fix that has stopped arriving is a pace that has stopped being true — GPS under trees
    /// drops for seconds at a time, and the last one it managed is not what is happening now.
    ///
    /// What is left is mostly **not** the sport's speed series: a walk has no live one at all,
    /// and a run only has one where a watch is writing it, which is the case this screen
    /// exists for the absence of. So the fallback is the distance of the last twenty seconds
    /// over those seconds — the same shape as the cadence and for the same reason. It moves in
    /// steps rather than smoothly, because that is how the pedometer hands distance over.
    private func readSpeed(at now: Date) {
        // Whether a fix is carrying the pace right now. Asked rather than inferred from the
        // reading being non-nil: outdoors with location refused, or with a receiver that
        // never reports a speed, `fixedAt` stays nil for ever — and reading it as "a fix has
        // this in hand" froze the first derived pace on the screen for the whole session.
        let carried = fixedAt.map { now.timeIntervalSince($0) <= Self.staleFix } ?? false
        guard !carried else { return }

        // Dropped as well as cleared: what is in it is older than the gap, and averaging it
        // back in when the fixes return would be a pace from before the athlete stopped.
        speedMS = nil
        fixes.removeAll()

        if let series = latest(
            HKQuantityType(isCycling ? .cyclingSpeed : .runningSpeed),
            in: .meter().unitDivided(by: .second())
        ) {
            speedMS = series
            return
        }

        guard let metres else { return }
        distances.append((at: now, metres: metres))
        distances.removeAll { now.timeIntervalSince($0.at) > Self.speedWindow }

        guard let oldest = distances.first else { return }
        let span = now.timeIntervalSince(oldest.at)
        guard span >= Self.speedFloor else { return }

        let moved = (metres - oldest.metres) / span
        speedMS = moved < Self.movingMS ? nil : moved
    }

    // --- Where the phone is ------------------------------------------------------------------

    /// The route, and the live speed a screen can show: HealthKit generates distance and
    /// energy on its own, but a distance divided by an elapsed time is an average rather than
    /// what the athlete is doing now.
    ///
    /// When-in-use with background updates on, rather than always: a recording runs with the
    /// arrow in the status bar and stops when it ends, so the stronger grant would buy
    /// nothing and ask for much more.
    /// Location before there is a session, so the count-in is spent getting a fix rather than
    /// merely spent. A cold receiver takes tens of seconds, and the seconds it would otherwise
    /// take are the first of the recording — which is the stretch an athlete is standing still
    /// in and the one whose pace comes out as nonsense.
    func warmUp() {
        guard !indoors else { return }
        startLocating()
    }

    private func startLocating() {
        locations.delegate = self
        locations.activityType = .fitness
        locations.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        locations.allowsBackgroundLocationUpdates = true
        locations.showsBackgroundLocationIndicator = true
        locations.requestWhenInUseAuthorization()
        locations.startUpdatingLocation()
    }

    private func stopLocating() {
        locations.stopUpdatingLocation()
        locations.allowsBackgroundLocationUpdates = false
    }

    private func took(_ arriving: [CLLocation]) {
        let usable = arriving.filter { $0.horizontalAccuracy > 0 && $0.horizontalAccuracy <= Self.usableAccuracy }
        guard !usable.isEmpty else { return }

        // A negative speed is CoreLocation saying it does not have one, which is not the same
        // as standing still, so it leaves the reading alone rather than zeroing it.
        if let speed = usable.last?.speed, speed >= 0 {
            let now = Date()
            fixes.append((at: now, speed: speed))
            fixes.removeAll { now.timeIntervalSince($0.at) > Self.paceWindow }

            let mean = fixes.reduce(0) { $0 + $1.speed } / Double(fixes.count)
            speedMS = mean < Self.movingMS ? nil : mean
            fixedAt = now
        }
        route?.insertRouteData(usable) { _, _ in }
    }
}

// --- What the frameworks call back ---------------------------------------------------------

@available(iOS 26.0, *)
extension WorkoutRunner: HKWorkoutSessionDelegate {
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        Task { @MainActor in
            if toState == self.waitingFor { self.stopWaiting() }

            // The one place the session's state is written down, and the one place the
            // screen learns it changed. Said from here rather than from the buttons for the
            // same reason: it is the session's own word for what happened. Resuming is
            // announced only from a pause — every workout reaches `.running` when it starts,
            // and it has just said what it is starting.
            self.sessionState = toState

            switch toState {
            case .running where fromState == .paused: self.voice.say("Resumed.")
            case .paused: self.voice.say("Paused.")
            default: break
            }
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            // Released as well as reported: a failure while something is waiting on a state
            // it will now never reach would otherwise hold it there until the limit.
            self.phase = .failed(error.localizedDescription)
            self.stopWaiting()
        }
    }
}

@available(iOS 26.0, *)
extension WorkoutRunner: HKLiveWorkoutBuilderDelegate {
    /// The samples are read off the builder rather than out of `collectedTypes`, because the
    /// builder holds the running statistics and the callback only says which of them moved.
    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>
    ) {
        Task { @MainActor in self.read(onTick: false) }
    }

    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {}
}

@available(iOS 26.0, *)
extension WorkoutRunner: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations fixes: [CLLocation]) {
        Task { @MainActor in self.took(fixes) }
    }

    /// Silent on purpose. A fix that does not arrive is a pace the screen cannot show, which
    /// it already says by showing nothing; it is not a reason to interrupt a recording.
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}
}

#endif
