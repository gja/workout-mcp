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

/// Where a recording has got to. `failed` carries what to put in front of the athlete,
/// because every way this can go wrong happens while they are standing outside waiting.
enum RunPhase: Equatable {
    case starting
    case running
    case paused
    case saving
    case saved
    case failed(String)
}

@available(iOS 26.0, *)
@MainActor
final class WorkoutRunner: NSObject, ObservableObject {
    @Published private(set) var phase: RunPhase = .starting

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
    private var ending: CheckedContinuation<Void, Never>?

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
    private var intervalFromMetres: Double = 0
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

    /// When the last usable fix arrived, so a pace can be dropped once it stops being one.
    private var fixedAt: Date?
    private static let staleFix = 10.0

    /// A fix this far out is the phone guessing, and a guess this app records is a guess the
    /// server will compute a pace from. Apple's own advice for a workout route.
    private static let usableAccuracy = 50.0

    /// Below a crawl, a GPS speed is the fix moving rather than the athlete. Under this, the
    /// screen says nothing instead of counting out a pace nobody is running.
    private static let movingMS = 0.5

    /// An interval pace over the first few strides of it is the rounding on one GPS fix. Far
    /// enough in, it is a pace.
    private static let paceableMetres = 20.0

    /// How long to wait for the session to actually end before saving anyway. A wait with no
    /// limit loses the recording exactly as completely as saving too early would.
    private static let endingLimit = 10.0

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
    func begin() async {
        if let recovered {
            resume(recovered)
            return
        }
        if await resumeRecovered() { return }

        guard let workout else {
            phase = .failed("There is no workout to start.")
            return
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

            openInterval(at: at)
            follow()
            phase = .running
        } catch {
            // The session was started before whatever threw, and a session nothing ends keeps
            // recording with no screen left that can stop it.
            session?.end()
            session = nil
            stop()
            phase = .failed(error.localizedDescription)
        }
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
    /// a recording nobody can find is a recording nobody can stop. See `RunRecovery`.
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
        follow()
        phase = recovered.state == .paused ? .paused : .running
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

    func pause() {
        session?.pause()
    }

    func resume() {
        session?.resume()
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
        guard phase == .running || phase == .paused else { return }

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
        voice.say(step?.spoken(number: interval + 1, of: steps.count) ?? "Past the plan.")
    }

    /// What this interval counts from. Separate from opening one because a recovered session
    /// needs the counting reset without a lap being cut: the laps it already has are in the
    /// session, and one more at the moment somebody reopened the app is not a lap they ran.
    private func rebase() {
        intervalFromElapsed = elapsed
        intervalFromMetres = metres ?? 0
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
            phase = .failed("Nothing was recording.")
            return
        }

        let at = Date()
        // Only what this app opened. `session.end()` closes whatever is still open anyway.
        if cutting { session.endCurrentActivity(on: at) }
        session.end()
        await waitUntilEnded()

        do {
            try await builder.endCollection(at: at)
            guard let saved = try await builder.finishWorkout() else {
                phase = .failed("Health did not save the session.")
                return
            }
            if let route { _ = try? await route.finishRoute(with: saved, metadata: nil) }
            phase = .saved
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func waitUntilEnded() async {
        guard let session, session.state != .ended else { return }

        let limit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.endingLimit))
            await self?.stopWaiting()
        }
        await withCheckedContinuation { ending = $0 }
        limit.cancel()
    }

    /// Resumed from exactly one of two places — the delegate saying `.ended`, or the limit
    /// running out — and the continuation is cleared first so neither can resume it twice.
    private func stopWaiting() {
        let waiting = ending
        ending = nil
        waiting?.resume()
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
                await self?.read(onTick: true)
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
        intervalMetres = metres.map { max(0, $0 - intervalFromMetres) }
        intervalPaceSKm = intervalMetres.flatMap { metres in
            metres >= Self.paceableMetres && intervalElapsed > 0
                ? intervalElapsed / (metres / 1000)
                : nil
        }

        heartRate = latest(HKQuantityType(.heartRate), in: .count().unitDivided(by: .minute()))
        power = latest(HKQuantityType(isCycling ? .cyclingPower : .runningPower), in: .watt())
        if onTick {
            averagePower()
            readCadence()
        }
        readSpeed()

        // Judged only on the tick, and only once every figure above has been read: a drift
        // counted at the rate samples happen to land is a drift counted at no rate at all,
        // and the advance has to see the distance this second's fix brought in.
        guard onTick, phase == .running else { return }
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
        voice.say("5 seconds")
    }

    private func callOutDrift() {
        let now = Date()
        for index in watches.indices {
            let reading: Double?
            switch watches[index].metric {
            case .speed: reading = speedMS
            case .heartRate: reading = heartRate
            case .power: reading = power
            case .cadence: reading = cadence
            }
            if let said = watches[index].read(reading, at: now) { voice.say(said) }
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
    private func readCadence() {
        if isCycling {
            cadence = latest(HKQuantityType(.cyclingCadence), in: .count().unitDivided(by: .minute()))
            return
        }

        guard let steps = builder?.statistics(for: HKQuantityType(.stepCount))?
            .sumQuantity()?.doubleValue(for: .count()) else { return }

        let now = Date()
        stepCounts.append((now, steps))
        stepCounts.removeAll { now.timeIntervalSince($0.at) > Self.cadenceWindow }

        guard let oldest = stepCounts.first else { return }
        let span = now.timeIntervalSince(oldest.at)
        cadence = span >= Self.cadenceFloor ? (steps - oldest.steps) / span * 60 : nil
    }

    /// A fix that has stopped arriving is a pace that has stopped being true — GPS under trees
    /// drops for seconds at a time, and the last one it managed is not what is happening now.
    /// What is left, indoors or in the gap, is the sport's own speed series off the pedometer.
    private func readSpeed() {
        if let fixedAt, Date().timeIntervalSince(fixedAt) > Self.staleFix { speedMS = nil }
        guard indoors || speedMS == nil else { return }
        speedMS = latest(
            HKQuantityType(isCycling ? .cyclingSpeed : .runningSpeed),
            in: .meter().unitDivided(by: .second())
        )
    }

    // --- Where the phone is ------------------------------------------------------------------

    /// The route, and the live speed a screen can show: HealthKit generates distance and
    /// energy on its own, but a distance divided by an elapsed time is an average rather than
    /// what the athlete is doing now.
    ///
    /// When-in-use with background updates on, rather than always: a recording runs with the
    /// arrow in the status bar and stops when it ends, so the stronger grant would buy
    /// nothing and ask for much more.
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

    private func took(_ fixes: [CLLocation]) {
        let usable = fixes.filter { $0.horizontalAccuracy > 0 && $0.horizontalAccuracy <= Self.usableAccuracy }
        guard !usable.isEmpty else { return }

        // A negative speed is CoreLocation saying it does not have one, which is not the same
        // as standing still, so it leaves the reading alone rather than zeroing it.
        if let speed = usable.last?.speed, speed >= 0 {
            speedMS = speed < Self.movingMS ? nil : speed
            fixedAt = Date()
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
            switch toState {
            case .running: self.phase = .running
            case .paused: self.phase = .paused
            // Not a phase: `end()` is saving by now and has the save to wait for. This is
            // what it is waiting on.
            case .ended: self.stopWaiting()
            default: break
            }
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in
            // Released as well as reported: a failure while `end()` is waiting would otherwise
            // hold it there until the limit, with nothing left to wait for.
            self.stopWaiting()
            self.phase = .failed(error.localizedDescription)
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
