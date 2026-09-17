// Permission, and the listing of what the athlete actually recorded. Read-only: this app
// never writes a sample back into Health.

import Foundation
import HealthKit

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

    /// Everything a FIT file of a run or a ride can carry, and nothing else.
    static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [
            HKObjectType.workoutType(),
            HKSeriesType.workoutRoute(),
            HKQuantityType(.heartRate),
            HKQuantityType(.distanceWalkingRunning),
            HKQuantityType(.distanceCycling),
            HKQuantityType(.stepCount),
            HKQuantityType(.activeEnergyBurned),
        ]
        types.formUnion([
            HKQuantityType(.runningPower),
            HKQuantityType(.runningSpeed),
            HKQuantityType(.cyclingPower),
            HKQuantityType(.cyclingCadence),
            HKQuantityType(.cyclingSpeed),
        ])
        return types
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
    /// The key iOS files a WorkoutKit plan's id under is not in the public headers this app
    /// compiles against, so it is read by name and a miss is not a failure: the athlete picks
    /// the workout themselves, and the day and the sport narrow the list to one most of the time.
    static func planID(of workout: HKWorkout) -> UUID? {
        let names = ["HKWorkoutPlanId", "HKMetadataKeyWorkoutPlanId", "WorkoutPlanId"]
        for name in names {
            guard let raw = workout.metadata?[name] else { continue }
            if let id = raw as? UUID { return id }
            if let text = raw as? String, let id = UUID(uuidString: text) { return id }
        }
        return nil
    }

    static func isIndoor(_ workout: HKWorkout) -> Bool {
        (workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool) == true
    }

    static func sport(of workout: HKWorkout) -> FitSport {
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

    static func subSport(of workout: HKWorkout) -> FitSubSport {
        switch (sport(of: workout), isIndoor(workout)) {
        case (.running, true): return .treadmill
        case (.running, false): return .street
        case (.cycling, true): return .indoorCycling
        case (.cycling, false): return .road
        default: return .generic
        }
    }

    static func distance(of workout: HKWorkout) -> Double? {
        let type: HKQuantityType = sport(of: workout) == .cycling
            ? HKQuantityType(.distanceCycling)
            : HKQuantityType(.distanceWalkingRunning)
        return workout.statistics(for: type)?.sumQuantity()?.doubleValue(for: .meter())
    }
}
