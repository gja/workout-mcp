// A planned session recorded on the phone itself, for an athlete whose watch is not an
// Apple Watch or is on the charger. HealthKit's own workout session — the one watchOS has
// always had, and iPhone has had since iOS 26 — so what this saves is an ordinary
// `HKWorkout` and the way back to the server is the one every other session already takes.
//
// It records; it does not conduct. The steps are not counted out, no alert sounds and
// nothing is compared against the plan while it runs. See "Recording it on the phone" in
// docs/ios.md for why that line is where it is.

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

    /// Moving figures, and every one of them optional. A heart rate of zero and a pace of
    /// zero are what an absent chest strap and a cold GPS fix look like, and the screen has
    /// to be able to say "nothing yet" rather than claim a measurement — the same rule the
    /// FIT file is written under. See docs/stats.md.
    @Published private(set) var elapsed: TimeInterval = 0
    @Published private(set) var metres: Double?
    @Published private(set) var heartRate: Double?
    @Published private(set) var speedMS: Double?

    let workout: PlannedWorkout

    private let configuration: HKWorkoutConfiguration
    private let distanceType: HKQuantityType
    private var session: HKWorkoutSession?
    private var builder: HKLiveWorkoutBuilder?
    private var route: HKWorkoutRouteBuilder?
    private let locations = CLLocationManager()
    private var clock: Task<Void, Never>?

    /// A fix this far out is the phone guessing, and a guess this app records is a guess the
    /// server will compute a pace from. Apple's own advice for a workout route.
    private static let usableAccuracy = 50.0

    /// Below a crawl, a GPS speed is the fix moving rather than the athlete. Under this, the
    /// screen says nothing instead of counting out a pace nobody is running.
    private static let movingMS = 0.5

    init(workout: PlannedWorkout) {
        self.workout = workout

        let configuration = HKWorkoutConfiguration()
        configuration.activityType = Sports.activityType(workout.sport)
        configuration.locationType = Sports.location(workout.subSport)
        self.configuration = configuration
        distanceType = configuration.activityType == .cycling
            ? HKQuantityType(.distanceCycling)
            : HKQuantityType(.distanceWalkingRunning)

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
                HKMetadataKeyIndoorWorkout: configuration.locationType == .indoor,
            ])

            follow()
            phase = .running
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// A recovered session keeps the workout it was started for, because the key was written
    /// into it then: what this screen says above the clock can be the wrong name, and what is
    /// saved cannot be the wrong workout.
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
        if configuration.locationType == .outdoor {
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

    /// Ending is two things that have to happen in order and a third that can fail without
    /// costing the session: the session stops, the builder is closed and saved, and the route
    /// is attached to the workout that came back. A route that will not attach is a session
    /// with no line on the map, which is worth less than the session and not worth losing it.
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
        metres = builder.statistics(for: distanceType)?.sumQuantity()?.doubleValue(for: .meter())
        heartRate = builder.statistics(for: HKQuantityType(.heartRate))?
            .mostRecentQuantity()?
            .doubleValue(for: .count().unitDivided(by: .minute()))
    }

    // --- Where the phone is ------------------------------------------------------------------

    /// The route, and the only live speed there is: HealthKit generates distance and energy
    /// on its own, but nothing hands over a speed a screen can show, and a distance divided
    /// by an elapsed time is an average rather than what the athlete is doing now.
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
