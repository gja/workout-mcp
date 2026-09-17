// Permission, and the listing of what the athlete actually recorded. Read-only: this app
// never writes a sample back into Health.

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

    /// Every channel a FIT file of a run or a ride can carry, and nothing else. A type the
    /// athlete declines, or a sensor they were not wearing, comes back empty rather than
    /// failing: a run with no power meter is still a run worth uploading.
    static var readTypes: Set<HKObjectType> {
        [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
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

    static func request() async throws {
        guard HKHealthStore.isHealthDataAvailable() else { throw HealthError.unavailable }
        try await store.requestAuthorization(toShare: [], read: readTypes)
    }

    /// The runs and rides of the last `days` days, newest first. Swim is out of scope.
    static func recentActivities(days: Int) async throws -> [HKWorkout] {
        let since = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
        let sports = NSCompoundPredicate(orPredicateWithSubpredicates: [
            HKQuery.predicateForWorkouts(with: .running),
            HKQuery.predicateForWorkouts(with: .cycling),
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
        default: return .generic
        }
    }

    /// So a view can say "Ride" without knowing what a FIT sport is.
    static func isRide(_ workout: HKWorkout) -> Bool { sport(of: workout) == .cycling }

    static func distance(of workout: HKWorkout) -> Double? {
        let type: HKQuantityType = sport(of: workout) == .cycling
            ? HKQuantityType(.distanceCycling)
            : HKQuantityType(.distanceWalkingRunning)
        return workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: .meter())
    }
}
