// A planned session recorded on the phone itself, on Apple's own workout session. The
// lifecycle follows their sample; the plan, the laps and the voice sit on top. See docs/ios.md.
#if ON_PHONE_RECORDING
import CoreLocation
import Foundation
import HealthKit

/// The app's own lifecycle. Running and paused belong to the session, not to this.
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

    // --- What the screen reads -----------------------------------------------------------

    @Published private(set) var phase: RunPhase = .starting

    /// The session's state, written only by `became`. `HKWorkoutSession.state` is never read.
    @Published private(set) var sessionState: HKWorkoutSessionState = .notStarted

    /// Something a live session refused. A line to read, not an ending.
    @Published private(set) var problem: String?

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

    /// Which step the athlete is on. Moved by `opened`, when HealthKit says the lap is cut.
    @Published private(set) var interval = 0

    let workout: PlannedWorkout?
    let steps: [RunStep]
    var step: RunStep? { steps.indices.contains(interval) ? steps[interval] : nil }

    var isRecording: Bool { phase == .live }
    var isPaused: Bool { sessionState == .paused }

    /// A paused workout has no laps in it, and neither has one whose lap is still opening.
    var lappable: Bool { !opening && sessionState == .running }

    // --- The session ---------------------------------------------------------------------

    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var route: HKWorkoutRouteBuilder?
    private let recovered: HKWorkoutSession?

    private var configuration: HKWorkoutConfiguration
    private var distanceType: HKQuantityType
    private(set) var indoors: Bool
    private(set) var isCycling: Bool

    /// Everything the delegates say, in the order they said it.
    ///
    /// Apple's sample: "The Swift actors don't handle tasks in a first-in-first-out manner.
    /// Use `AsyncStream` to ensure that the app presents the latest state." Each
    /// `Task { @MainActor in … }` out of a `nonisolated` delegate is unordered, so a pause and
    /// the resume after it can arrive the wrong way round.
    private enum Word {
        case state(HKWorkoutSessionState, Date)
        case event(HKWorkoutEventType)
        case activityBegan
        case refused(String)
    }
    private let words = AsyncStream.makeStream(of: Word.self, bufferingPolicy: .unbounded)
    private var listening: Task<Void, Never>?

    /// When the session said it stopped. `endCollection` uses it; a date read afterwards is a
    /// guess, and one a second late is refused with "workout activity did not occur".
    private var stoppedAt: Date?

    private var waiting: CheckedContinuation<Void, Never>?
    private var waitingFor: HKWorkoutSessionState?
    private static let stateLimit = 10.0

    // --- The plan, and what is said about it ----------------------------------------------

    private let voice = RunVoice()
    private var watches: [TargetWatch] = []
    private var countedDown = false
    private static let warning = 5.0

    // --- Laps -----------------------------------------------------------------------------

    /// A lap cut and not yet reported open by `didBeginActivityWith`. `beginNewActivity` is
    /// asynchronous, and nothing about the interval moves until HealthKit says it took.
    private var opening = false
    private var openingBy: Task<Void, Never>?
    private static let openingLimit = 2.0

    /// Whether the lap being opened is a new interval or the session's first.
    private var advancingTo = false

    /// The interval's baseline, read when the lap was cut — the activity begins then, whatever
    /// time the callback arrives.
    private var openedFrom: (elapsed: TimeInterval, metres: Double?)?

    /// Whether this app has an activity open for `endCurrentActivity` to close.
    private var cutting = false

    private var intervalFromElapsed: TimeInterval = 0
    private var intervalFromMetres: Double?

    // --- Clocks -----------------------------------------------------------------------------

    private var clock: Task<Void, Never>?
    private static let settle = 0.25

    /// `HKLiveWorkoutBuilder.elapsedTime` is documented as counting "including pauses", so the
    /// paused stretches are measured on its own clock and taken back off.
    private var pausedFor: TimeInterval = 0
    private var pausedFrom: TimeInterval?
    private var moving: TimeInterval { max(0, (builder?.elapsedTime ?? 0) - pausedFor) }

    // --- Readings ----------------------------------------------------------------------------

    private var powerSum = 0.0
    private var powerReadings = 0
    private var stepCounts: [(at: Date, steps: Double)] = []
    private static let cadenceWindow = 15.0
    private static let cadenceFloor = 5.0

    private let locations = CLLocationManager()
    private var fixedAt: Date?
    private var fixes: [(at: Date, speed: Double)] = []
    private static let paceWindow = 10.0
    private static let staleFix = 10.0
    private var distances: [(at: Date, metres: Double)] = []
    private static let speedWindow = 20.0
    private static let speedFloor = 8.0
    private static let usableAccuracy = 50.0
    private static let movingMS = 0.5
    private static let paceableMetres = 20.0

    // --- Building ------------------------------------------------------------------------------

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

        // One consumer, one at a time: the next word waits on the last, which is the ordering.
        listening = Task { [weak self] in
            guard let stream = self?.words.stream else { return }
            for await word in stream { await self?.heard(word) }
        }
    }

    deinit {
        // The consumer waits on a stream that never ends by itself.
        words.continuation.finish()
    }

    // --- Starting -------------------------------------------------------------------------------

    /// Picks up a session already running before starting one: HealthKit keeps ours alive
    /// across a force-quit and refuses a second.
    func begin() async -> Bool {
        if let recovered { return await carryOn(recovered) }
        if let found = await Self.active() { return await carryOn(found) }

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
            // Written at the start, not the end, because that is where a recording is most
            // likely to be interrupted. It is what matches the session to its plan.
            try await builder?.addMetadata([
                HealthAccess.workoutKeyMetadata: workout.key,
                HKMetadataKeyIndoorWorkout: indoors,
            ])

            await wait(for: .running)
            guard sessionState == .running else { return abandon("Health did not start the session.") }

            // So a session picked up in another process has its plan without the network.
            Underway.remember(key: workout.key, steps: steps)

            phase = .live
            openInterval(at: Date(), advancing: false)
            // A lap HealthKit could not cut arrives as the session failing, on its own turn.
            try? await Task.sleep(for: .seconds(Self.settle))
            if case .failed(let why) = phase { return abandon(why) }

            follow()
            return true
        } catch {
            return abandon(error.localizedDescription)
        }
    }

    private func carryOn(_ found: HKWorkoutSession) async -> Bool {
        adopt(found)
        elapsed = builder?.elapsedTime ?? 0
        // Read before rebasing, or the interval counts from zero while the session is minutes
        // in, and the first tick finds a 60-second step long since due.
        read(onTick: false)
        rebase()

        switch sessionState {
        case .ended, .stopped:
            // Nothing to resume in a session that is over; only the saving it never got.
            // `end` sets `.saving` itself, and returns early if it is already set.
            await end()
        default:
            phase = .live
            follow()
        }
        return isRecording
    }

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
        // Adopting one raises no callback, so this is the one read of `state` in the app.
        sessionState = session.state
        // Apple calls this when the session is built: it warms the sensors, so starting is not
        // also the moment the hardware wakes up.
        if session.state == .notStarted { session.prepare() }

        if !indoors {
            route = HKWorkoutRouteBuilder(healthStore: HealthAccess.store, device: nil)
            startLocating()
        }
    }

    /// Cadence and power are asked for by name: the data source collects neither on its own,
    /// and a type nobody collects is a dash for ever and an empty channel in the file.
    private func source() -> HKLiveWorkoutDataSource {
        let source = HKLiveWorkoutDataSource(
            healthStore: HealthAccess.store, workoutConfiguration: configuration
        )
        source.enableCollection(for: HKQuantityType(isCycling ? .cyclingCadence : .stepCount), predicate: nil)
        if isCycling { source.enableCollection(for: HKQuantityType(.cyclingPower), predicate: nil) }
        return source
    }

    private func abandon(_ why: String) -> Bool {
        session?.end()
        session = nil
        stop()
        phase = .failed(why)
        return false
    }

    static func active() async -> HKWorkoutSession? {
        try? await HealthAccess.store.recoverActiveWorkoutSession()
    }

    static func workoutKey(of session: HKWorkoutSession) -> String? {
        session.associatedWorkoutBuilder().metadata[HealthAccess.workoutKeyMetadata] as? String
    }

    // --- The buttons ------------------------------------------------------------------------------

    /// Apple's own: ask the session, and let the delegate change the screen.
    func togglePause() {
        switch sessionState {
        case .running: session?.pause()
        case .paused: session?.resume()
        default: break
        }
    }

    func nextInterval() {
        guard lappable else { return }
        openInterval(at: Date(), advancing: true)
    }

    /// `beginNewActivity` ends whichever activity is open, so nothing is closed first:
    /// `endCurrentActivity` with nothing of ours open failed the first session recorded here.
    private func openInterval(at: Date, advancing: Bool) {
        guard lappable else { return }
        session?.beginNewActivity(configuration: configuration, date: at, metadata: nil)

        // Nothing about the interval moves until HealthKit reports the activity open. The
        // baseline is taken here, because the activity begins when it was asked for.
        advancingTo = advancing
        openedFrom = (elapsed: moving, metres: metres)
        opening = true

        openingBy?.cancel()
        openingBy = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(Self.openingLimit)) } catch { return }
            self?.opened()
        }
    }

    /// The lap is open: the interval it opens is counted and the step it names is announced.
    private func opened() {
        guard opening else { return }
        opening = false
        openingBy?.cancel()
        openingBy = nil

        // `.starting` too: the session's first activity opens before `begin()` has finished.
        switch phase {
        case .starting, .live: break
        default:
            advancingTo = false
            openedFrom = nil
            return
        }

        if advancingTo { interval += 1 }
        advancingTo = false
        cutting = true
        rebase()
        voice.say(step?.spoken ?? "Workout complete.")
    }

    /// The lap was refused, so nothing about it counts.
    private func openingFailed() {
        guard opening else { return }
        opening = false
        openingBy?.cancel()
        openingBy = nil
        advancingTo = false
        openedFrom = nil
    }

    /// What this interval counts from. Separate from opening one, because a recovered session
    /// needs the counting reset without a lap being cut.
    private func rebase() {
        intervalFromElapsed = openedFrom?.elapsed ?? moving
        intervalFromMetres = openedFrom?.metres ?? metres
        openedFrom = nil
        powerSum = 0
        powerReadings = 0
        intervalElapsed = 0
        intervalMetres = nil
        intervalPaceSKm = nil
        intervalPower = nil

        watches = (step?.targets ?? []).compactMap(TargetWatch.init)
        countedDown = false
    }

    // --- Ending -----------------------------------------------------------------------------------

    /// Apple's order: stop the activity, wait for `.stopped`, end the collection at the date the
    /// delegate was handed, finish the workout, end the session last.
    func end() async {
        if case .saving = phase { return }
        phase = .saving
        stop()

        guard let session, let builder else {
            phase = .failed("Nothing was recording.")
            return
        }

        SyncLog.record(.upload, "ending: state \(sessionState.rawValue), cut \(cutting)")

        if sessionState == .running || sessionState == .paused {
            let at = Date()
            if cutting { session.endCurrentActivity(on: at) }
            session.stopActivity(with: at)
            await wait(for: .stopped)
        }

        do {
            // Its failure is not reported: a collection already ended refuses a second one, and
            // what decides whether the session survives is `finishWorkout`.
            try? await builder.endCollection(at: stoppedAt ?? Date())
            guard let saved = try await builder.finishWorkout() else {
                phase = .failed("Health did not save the session.")
                return
            }
            session.end()
            SyncLog.record(.upload, "ending: saved \(saved.uuid)")
            if let route { _ = try? await route.finishRoute(with: saved, metadata: nil) }
            Underway.clear()
            phase = .saved
        } catch {
            SyncLog.record(.upload, "could not save the session: \(SyncLog.describe(error))")
            phase = .failed(error.localizedDescription)
        }
    }

    /// With a limit, because a wait that never returns loses the session as completely as saving
    /// too early would.
    private func wait(for state: HKWorkoutSessionState) async {
        guard sessionState != state else { return }
        stopWaiting()

        waitingFor = state
        let limit = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(Self.stateLimit)) } catch { return }
            self?.stopWaiting()
        }
        await withCheckedContinuation { waiting = $0 }
        limit.cancel()
    }

    private func stopWaiting() {
        let held = waiting
        waiting = nil
        waitingFor = nil
        held?.resume()
    }

    // --- The tick ------------------------------------------------------------------------------------

    func stop() {
        clock?.cancel()
        clock = nil
        stopLocating()
        voice.stop()
    }

    /// Reachable from the screen, because SwiftUI calls `onDisappear` for a rebuild as readily as
    /// for a screen that has gone, and `stop` used to be a one-way door.
    func follow() {
        guard case .live = phase else { return }
        if !indoors { startLocating() }
        guard clock == nil else { return }
        read(onTick: true)

        clock = Task { [weak self] in
            while !Task.isCancelled {
                // Not `try?`: a swallowed cancellation runs one more tick, inside `end()`, where
                // the auto-advance can still reach `beginNewActivity`.
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                self?.tick()
            }
        }
    }

    private func tick() {
        guard case .live = phase else { return }
        read(onTick: true)
    }

    /// `onTick` separates the figures simply read from the ones accumulated: the builder's
    /// delegate fires whenever samples land, which is no rate worth averaging against.
    private func read(onTick: Bool) {
        guard let builder else { return }

        if sessionState == .running { elapsed = moving }
        intervalElapsed = max(0, elapsed - intervalFromElapsed)

        metres = builder.statistics(for: distanceType)?.sumQuantity()?.doubleValue(for: .meter())
        // Taken at the first reading of the interval rather than at its opening, because there
        // may not have been one to take then.
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

        // Judged on the tick and only once every figure above is read: a drift counted at the
        // rate samples happen to land is counted at no rate at all.
        guard onTick, lappable else { return }
        advanceIfDue()
        countDown()
        callOutDrift()
    }

    /// A step with an end advances itself at it. An open one — "until lap press" — never does,
    /// and neither does a press past the end of the plan.
    private func advanceIfDue() {
        guard let step else { return }
        if let seconds = step.seconds, intervalElapsed >= seconds { nextInterval(); return }
        if let metres = step.metres, let run = intervalMetres, run >= metres { nextInterval() }
    }

    /// Only for a step that ends on a clock: a step measured in metres has no five seconds left.
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

    /// This interval's own readings: the builder's average is the session's and does not come
    /// apart again at a lap.
    private func averagePower() {
        guard let watts = power else { return }
        powerSum += watts
        powerReadings += 1
        intervalPower = powerSum / Double(powerReadings)
    }

    /// HealthKit counts steps and does not count them per minute, and a cadence off one second of
    /// them swings by twenty with every stride landing either side of a tick.
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

    /// GPS where there is a fix, then HealthKit's own series, then distance over time: a walk has
    /// no live speed series at all and a run only has one where a watch is writing it.
    private func readSpeed(at now: Date) {
        let carried = fixedAt.map { now.timeIntervalSince($0) <= Self.staleFix } ?? false
        guard !carried else { return }
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

    // --- Location --------------------------------------------------------------------------------

    /// Started at the tap rather than at the start, so the count-in is GPS lock the recording does
    /// not have to spend.
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
        // Defaults to on, and with `.fitness` it will stop updates at a traffic light.
        locations.pausesLocationUpdatesAutomatically = false
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

    // --- Everything the frameworks say, in order ---------------------------------------------------

    private func heard(_ word: Word) async {
        switch word {
        case .state(let state, let date):
            if state == .ended || state == .stopped { stoppedAt = date }
            if state == waitingFor { stopWaiting() }
            became(state)

        case .event(let type):
            // `.motionPaused` is the system pausing the workout itself, and a paused workout is a
            // paused workout however it got there. There is no API to turn it off.
            switch type {
            case .pause, .motionPaused: became(.paused)
            case .resume, .motionResumed: became(.running)
            // `.pauseOrResumeRequest` is answered nowhere: Apple documents it as the athlete
            // pressing both *watch* buttons, and this screen exists for the athlete with none.
            default: SyncLog.record(.upload, "event \(type.rawValue) ignored")
            }

        case .activityBegan:
            opened()

        case .refused(let why):
            SyncLog.record(.upload, "session refused something: \(why)")
            // A live session that refused something has not ended: `failed` offers to retry the
            // *save*, which on a refused pause ended a workout that was going perfectly well.
            if opening { openingFailed() }
            if case .saving = phase { return }
            problem = why
        }
    }

    /// The one place `sessionState` is written.
    private func became(_ state: HKWorkoutSessionState) {
        guard state != sessionState else { return }
        let was = sessionState
        sessionState = state
        problem = nil

        // Measured on the builder's clock, which runs through a pause, so the total does not jump
        // by the length of one at the resume.
        switch state {
        case .paused where pausedFrom == nil:
            pausedFrom = builder?.elapsedTime
        case .running:
            if let from = pausedFrom {
                pausedFor += max(0, (builder?.elapsedTime ?? from) - from)
                pausedFrom = nil
            }
        default:
            break
        }

        SyncLog.record(.upload, "lap \(interval + 1): \(was.rawValue) -> \(state.rawValue)")

        switch state {
        case .running where was == .paused: voice.say("Resumed.")
        case .paused: voice.say("Paused.")
        case .ended, .stopped:
            // Ended from somewhere that is not this screen — Siri, the Lock Screen.
            if case .live = phase { Task { await end() } }
        default: break
        }
    }
}

// --- What the frameworks call back ---------------------------------------------------------

@available(iOS 26.0, *)
extension WorkoutRunner: HKWorkoutSessionDelegate {
    // Yielded synchronously rather than hopped to the main actor, because the hop loses order.
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didChangeTo toState: HKWorkoutSessionState,
        from fromState: HKWorkoutSessionState,
        date: Date
    ) {
        words.continuation.yield(.state(toState, date))
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didGenerate event: HKWorkoutEvent) {
        words.continuation.yield(.event(event.type))
    }

    /// The word for a lap being open. `beginNewActivity` is asynchronous, and until this arrives
    /// the session is part-way through swapping one activity for the next.
    nonisolated func workoutSession(
        _ workoutSession: HKWorkoutSession,
        didBeginActivityWith configuration: HKWorkoutConfiguration,
        date: Date
    ) {
        words.continuation.yield(.activityBegan)
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        words.continuation.yield(.refused(error.localizedDescription))
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

    nonisolated func workoutBuilderDidCollectEvent(_ workoutBuilder: HKLiveWorkoutBuilder) {
        guard let event = workoutBuilder.workoutEvents.last else { return }
        words.continuation.yield(.event(event.type))
    }

    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder, didBegin workoutActivity: HKWorkoutActivity
    ) {
        words.continuation.yield(.activityBegan)
    }
}

@available(iOS 26.0, *)
extension WorkoutRunner: CLLocationManagerDelegate {
    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations fixes: [CLLocation]) {
        Task { @MainActor in self.took(fixes) }
    }

    /// Silent on purpose: a fix that does not arrive is a pace the screen cannot show.
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {}

    /// Asking is not being granted, and `startUpdatingLocation` before the sheet is answered does
    /// nothing.
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard !self.indoors, case .live = self.phase else { return }
            switch manager.authorizationStatus {
            case .authorizedWhenInUse, .authorizedAlways: manager.startUpdatingLocation()
            default: break
            }
        }
    }

    nonisolated func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        Task { @MainActor in
            guard !self.indoors, case .live = self.phase else { return }
            manager.startUpdatingLocation()
        }
    }
}

#endif
