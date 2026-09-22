// Permission, and the listing of what the athlete actually recorded. It writes one thing
// and only on iOS 26: a session `WorkoutRunner` recorded on the phone. Everything else here
// reads.

import FITSwiftSDK
import Foundation
import HealthKit
import WorkoutKit

enum HealthError: LocalizedError {
    case unavailable
    case denied

    var errorDescription: String? {
        switch self {
        case .unavailable: return "Health is not available on this device."
        case .denied: return "WorkoutsMCP has not been allowed to read workouts. Turn it on in Settings › Health."
        }
    }
}

enum HealthAccess {
    static let store = HKHealthStore()

    /// Every channel a FIT file of a run or a ride can carry, plus the one figure that is
    /// about the athlete rather than a session — resting heart rate, which `HeartRate.swift`
    /// reads a year of. A type the athlete declines, or a sensor they were not wearing,
    /// comes back empty rather than failing: a run with no power meter is still a run worth
    /// uploading.
    static var readTypes: Set<HKObjectType> {
        [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
            HKQuantityType(.restingHeartRate),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.distanceCycling),
            HKQuantityType(.stepCount),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.respiratoryRate),
            HKQuantityType(.runningPower),
            HKQuantityType(.runningSpeed),
            HKQuantityType(.runningVerticalOscillation),
            HKQuantityType(.runningGroundContactTime),
            HKQuantityType(.runningStrideLength),
            HKQuantityType(.cyclingPower),
            HKQuantityType(.cyclingCadence),
            HKQuantityType(.cyclingSpeed),
        ]
    }

    /// What a session recorded on this phone saves, and nothing else. Empty below iOS 26 and
    /// empty in a build without `ON_PHONE_RECORDING`: a permission sheet asking to write what
    /// the app cannot write is a question with no answer worth giving.
    static var shareTypes: Set<HKSampleType> {
        #if !ON_PHONE_RECORDING
        return []
        #else
        guard #available(iOS 26.0, *) else { return [] }
        return [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
            HKQuantityType(.activeEnergyBurned),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.distanceCycling),
            // Cadence and power, which `WorkoutRunner` asks the live source to collect by
            // name. A type it collects and cannot save is a channel lost at `finishWorkout`.
            HKQuantityType(.stepCount),
            HKQuantityType(.cyclingCadence),
            HKQuantityType(.cyclingPower),
            // Collected by the live source on its own for a run, and read back by the
            // screen: a type it collects and cannot save is that channel lost at
            // `finishWorkout`, which is what this list is for.
            HKQuantityType(.runningSpeed),
            HKQuantityType(.runningPower),
            HKQuantityType(.cyclingSpeed),
            HKQuantityType(.basalEnergyBurned),
        ]
        #endif
    }

    /// The metadata key a session recorded here carries its planned workout in. `<date>/<id>`,
    /// and the same name the FIT file's developer field uses, because it is the same fact
    /// written down in the second place it has to survive.
    static let workoutKeyMetadata = "workout_mcp_id"

    /// The planned workout a session names, where this app recorded it and therefore knew.
    /// Not a guess and not a round trip — unlike `planID`, which is both — so it is asked
    /// first everywhere a session has to be placed.
    static func recordedKey(of workout: HKWorkout) -> String? {
        workout.metadata?[workoutKeyMetadata] as? String
    }

    static func request() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthError.unavailable }
        try await store.requestAuthorization(toShare: shareTypes, read: readTypes)
    }

    /// The runs, rides and walks of the last `days` days, newest first. Swim is out of scope.
    static func recentActivities(days: Int) async throws -> [HKWorkout] {
        let since = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let sports = NSCompoundPredicate(orPredicateWithSubpredicates: [
            HKQuery.predicateForWorkouts(with: .running),
            HKQuery.predicateForWorkouts(with: .cycling),
            HKQuery.predicateForWorkouts(with: .walking),
        ])
        let window = HKQuery.predicateForSamples(withStart: since, end: nil, options: .strictStartDate)

        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workout(NSCompoundPredicate(andPredicateWithSubpredicates: [sports, window]))],
            sortDescriptors: [SortDescriptor(\.startDate, order: .reverse)],
            limit: 100
        )
        return try await descriptor.result(for: store)
    }

    /// The scheduled plan this session was run against, where Health recorded one.
    ///
    /// WorkoutKit puts this on `HKWorkout` itself, and that is what this asks. It used to
    /// read the metadata dictionary under three guessed key names instead, on the belief
    /// that the key "is not in the public headers this app compiles against" — it is, as an
    /// extension rather than a metadata constant, and the guesses matched nothing. Every
    /// session came back unplanned, which is invisible on the screen, where the day and the
    /// sport usually settle it anyway, and total in the background, where that fallback is
    /// deliberately not used.
    ///
    /// The getter is `async throws` — it goes back to the store, and a plan it cannot produce
    /// is not the same as a session run without one — but both end the same way here: nothing
    /// to match on, so nil, and the session is shown as unplanned rather than filed against a
    /// guess. Callers that cannot await per session resolve these once; see `AppModel.planIDs`.
    static func planID(of workout: HKWorkout) async -> UUID? {
        (try? await workout.workoutPlan)?.id
    }

    static func isIndoor(_ workout: HKWorkout) -> Bool {
        (workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool) == true
    }

    static func sport(of workout: HKWorkout) -> Sport {
        switch workout.workoutActivityType {
        case .running: return .running
        case .cycling: return .cycling
        case .walking: return .walking
        case .hiking: return .hiking
        case .rowing: return .rowing
        case .swimming: return .swimming
        default: return .generic
        }
    }

    static func subSport(of workout: HKWorkout) -> SubSport {
        switch (sport(of: workout), isIndoor(workout)) {
        case (.running, true): return .treadmill
        case (.running, false): return .street
        case (.cycling, true): return .indoorCycling
        case (.cycling, false): return .road
        case (.walking, true): return .indoorWalking
        default: return .generic
        }
    }

    /// So a view can say "Ride" or "Walk" without knowing what a FIT sport is.
    static func label(of workout: HKWorkout) -> String {
        switch sport(of: workout) {
        case .cycling: return "Ride"
        case .walking: return "Walk"
        default: return "Run"
        }
    }

    static func distance(of workout: HKWorkout) -> Double? {
        let type: HKQuantityType = sport(of: workout) == .cycling
            ? HKQuantityType(.distanceCycling)
            : HKQuantityType(.distanceWalkingRunning)
        return workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: .meter())
    }
}
