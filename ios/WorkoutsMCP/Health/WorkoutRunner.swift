// A planned session recorded on the phone itself, for an athlete whose watch is not an
// Apple Watch or is on the charger. HealthKit's own workout session — the one watchOS has
// always had, and iPhone has had since iOS 26 — so what this saves is an ordinary
// `HKWorkout` and the way back to the server is the one every other session already takes.
//
// It is started **against a plan**: the steps come in already resolved and flattened, so the
// screen can say which interval of how many, what this one is aimed at, and what the last
// lap press did. It still does not conduct — nothing advances on its own and nothing beeps.
// See "Recording it on the phone" in docs/ios.md.

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

    let workout: PlannedWorkout
    let steps: [RunStep]
    let indoors: Bool

    var step: RunStep? { steps.indices.contains(interval) ? steps[interval] : nil }

    private let configuration: HKWorkoutConfiguration
    private let cycling: Bool
    private let distanceType: HKQuantityType
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var route: HKWorkoutRouteBuilder?
    private let locations = CLLocationManager()
    private var clock: Task<Void, Never>?

    /// Where this interval started, in the figures that only ever count up. Everything the
    /// screen says about the interval is the difference between now and one of these.
    private var intervalFromElapsed: TimeInterval = 0
    private var intervalFromMetres: Double = 0
    private var powerSum = 0.0
    private var powerReadings = 0

    /// Cumulative steps, read once a second and kept for as long as a cadence is taken over.
    /// HealthKit counts steps; it does not count them per minute, and a cadence off one
    /// second of them would swing by twenty with every stride landing either side of a tick.
    private var stepCounts: [(at: Date, steps: Double)] = []
    private static let cadenceWindow = 15.0
    private static let cadenceFloor = 5.0

    /// A fix this far out is the phone guessing, and a guess this app records is a guess the
    /// server will compute a pace from. Apple's own advice for a workout route.
    private static let usableAccuracy = 50.0

    /// Below a crawl, a GPS speed is the fix moving rather than the athlete. Under this, the
    /// screen says nothing instead of counting out a pace nobody is running.
    private static let movingMS = 0.5

    /// An interval pace over the first few strides of it is the rounding on one GPS fix. Far
    /// enough in, it is a pace.
    private static let paceableMetres = 20.0

    init(workout: PlannedWorkout, steps: [RunStep], indoors: Bool) {
        self.workout = workout
        self.steps = steps
        self.indoors = indoors

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = Sports.activityType(workout.sport)
        configuration.locationType = indoors ? .indoor : .outdoor
        self.configuration = configuration
        cycling = configuration.activityType == .cycling
        distanceType = cycling ? HKQuantityType(.distanceCycling) : HKQuantityType(.distanceWalkingRunning)

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
        if await resumeRecovered() { return }

        do {
            let session = try HKWorkoutSession(healthStore: HealthAccess.store, configuration: configuration)
            attach(to: session)

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
            phase = .failed(error.localizedDescription)
        }
    }

    /// A recovered session keeps the workout it was started for, because the key was written
    /// into it then: what this screen says above the clock can be the wrong name, and what is
    /// saved cannot be the wrong workout. The interval count starts again from one — it lived
    /// in the process that went away — and the laps already cut are still in the session.
    private func resumeRecovered() async -> Bool {
        guard let recovered = try? await HealthAccess.store.recoverActiveWorkoutSession() else { return false }

        attach(to: recovered)
        follow()
        phase = recovered.state == .paused ? .paused : .running
        return true
    }

    /// The wiring both ways in have to do. The builder comes off the session rather than
    /// being made beside it, so a recovered session brings its own collected samples with it.
    private func attach(to session: HKWorkoutSession) {
        let builder = session.associatedWorkoutBuilder()
        builder.dataSource = HKLiveWorkoutDataSource(
            healthStore: HealthAccess.store, workoutConfiguration: configuration
        )
        session.delegate = self
        builder.delegate = self

        self.session = session
        self.builder = builder
        if !indoors {
            route = HKWorkoutRouteBuilder(healthStore: HealthAccess.store, device: nil)
            startLocating()
        }
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
        guard let session, phase == .running || phase == .paused else { return }

        let at = Date()
        session.endCurrentActivity(on: at)
        interval += 1
        openInterval(at: at)
    }

    private func openInterval(at: Date) {
        session?.beginNewActivity(configuration: configuration, date: at, metadata: nil)

        intervalFromElapsed = elapsed
        intervalFromMetres = metres ?? 0
        powerSum = 0
        powerReadings = 0
        intervalElapsed = 0
        intervalMetres = nil
        intervalPaceSKm = nil
        intervalPower = nil
    }

    /// Ending is three things that have to happen in order and a fourth that can fail without
    /// costing the session: the last lap is closed, the session stops, the builder is closed
    /// and saved, and the route is attached to the workout that came back. A route that will
    /// not attach is a session with no line on the map, which is worth less than the session
    /// and not worth losing it.
    func end() async {
        phase = .saving
        stopLocating()
        clock?.cancel()
        clock = nil

        guard let session, let builder else {
            phase = .failed("Nothing was recording.")
            return
        }

        do {
            let at = Date()
            session.endCurrentActivity(on: at)
            session.end()
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

    /// Elapsed comes off the builder rather than off a start date this class keeps, because
    /// the builder is the one that knows what was paused.
    private func follow() {
        guard clock == nil else { return }
        read()

        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                await self?.read()
            }
        }
    }

    private func read() {
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
        power = latest(HKQuantityType(cycling ? .cyclingPower : .runningPower), in: .watt())
        readPower()
        readCadence()
        if indoors || speedMS == nil {
            speedMS = latest(
                HKQuantityType(cycling ? .cyclingSpeed : .runningSpeed),
                in: .meter().unitDivided(by: .second())
            )
        }
    }

    private func latest(_ type: HKQuantityType, in unit: HKUnit) -> Double? {
        builder?.statistics(for: type)?.mostRecentQuantity()?.doubleValue(for: unit)
    }

    /// Averaged over the readings this interval has taken rather than over the samples
    /// HealthKit holds, because the builder's own average is the whole session's and does not
    /// come apart again at a lap. A meter emits about once a second and this reads about once
    /// a second, so the two agree closely enough for a number to pedal at — and the averages
    /// in the **file** are HealthKit's own samples, read back by `SessionReader`, not these.
    private func readPower() {
        guard let watts = power else { return }
        powerSum += watts
        powerReadings += 1
        intervalPower = powerSum / Double(powerReadings)
    }

    /// Cycling cadence is measured and handed over; running cadence is not. HealthKit counts
    /// steps, so a runner's is the steps of the last few seconds over those seconds, which is
    /// also why it is absent for the first few: a cadence needs a window to be taken over.
    private func readCadence() {
        if cycling {
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

    // --- Where the phone is ------------------------------------------------------------------

    /// The route, and the live speed a screen can show: HealthKit generates distance and
    /// energy on its own, but a distance divided by an elapsed time is an average rather than
    /// what the athlete is doing now. Indoors there is no route and no fix, and the pace falls
    /// back to the sport's own speed series, which the pedometer feeds.
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
            default: break // Ending is `end()`'s to report, and it has the save to wait for.
            }
        }
    }

    nonisolated func workoutSession(_ workoutSession: HKWorkoutSession, didFailWithError error: Error) {
        Task { @MainActor in self.phase = .failed(error.localizedDescription) }
    }
}

@available(iOS 26.0, *)
extension WorkoutRunner: HKLiveWorkoutBuilderDelegate {
    /// The samples are read off the builder rather than out of `collectedTypes`, because the
    /// builder holds the running statistics and the callback only says which of them moved.
    nonisolated func workoutBuilder(
        _ workoutBuilder: HKLiveWorkoutBuilder, didCollectDataOf collectedTypes: Set<HKSampleType>
    ) {
        Task { @MainActor in self.read() }
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
