// Waking when a session is saved, and uploading the ones there is no doubt about.
//
// HealthKit will launch this app in the background when a workout lands, which is the only
// way a recording reaches the server without the athlete opening anything. It needs the
// `com.apple.developer.healthkit.background-delivery` entitlement, which is in
// `WorkoutsMCP.entitlements`, and an observer registered on every launch — including the
// background ones, which is why `start()` is called from the app's own initialiser rather
// than from a view.
//
// What it does on waking is deliberately narrow. A session is uploaded only where the watch
// itself named the plan it was run against; the day-and-sport fallback the home screen uses
// is a guess, and a guess is fine when the athlete is looking at it and wrong when it files
// a session against a workout nobody chose. Everything else waits in the list.

import Foundation
import HealthKit

enum BackgroundSync {
    private static var observer: HKObserverQuery?

    /// Idempotent: called on every launch, and the second call is a no-op.
    static func start() {
        guard HKHealthStore.isHealthDataAvailable(), observer == nil else { return }

        let query = HKObserverQuery(sampleType: .workoutType(), predicate: nil) { _, completion, error in
            guard error == nil else {
                // Still acknowledged. HealthKit backs off an observer that stops answering,
                // and a failed read is not a reason to stop being told about the next one.
                completion()
                return
            }
            Task {
                await uploadWhatIsCertain()
                completion()
            }
        }

        observer = query
        HealthAccess.store.execute(query)

        Task {
            try? await HealthAccess.store.enableBackgroundDelivery(for: .workoutType(), frequency: .immediate)
        }
    }

    /// Only the sessions the watch itself matched to a plan, and only the ones the server has
    /// not already read. A completion is what says it has: `isDone` comes back true on the
    /// listing once a recording has been ingested, so nothing needs a ledger of its own.
    private static func uploadWhatIsCertain() async {
        guard let client = StoredSession.load()?.client else { return }

        let from = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
        let to = Calendar.current.date(byAdding: .day, value: 14, to: Date()) ?? Date()

        guard let planned = try? await client.workouts(from: from, to: to),
              // Two days: a wake is for what just finished, and a background launch has
              // seconds rather than minutes to spend.
              let activities = try? await HealthAccess.recentActivities(days: 2) else { return }

        for activity in activities {
            guard let planID = HealthAccess.planID(of: activity),
                  let key = PlanLink.workoutKey(forPlan: planID),
                  let workout = planned.first(where: { $0.key == key }),
                  !workout.isDone else { continue }

            do {
                let recorded = try await SessionReader.read(activity, as: workout.key)
                try await client.upload(
                    try ActivityFit.encode(recorded),
                    to: workout,
                    activityID: activity.uuid.uuidString
                )
            } catch {
                // The next wake, or the athlete opening the app, tries again. There is nobody
                // here to tell, and a background launch is not the place to retry in a loop.
                return
            }
        }
    }
}
