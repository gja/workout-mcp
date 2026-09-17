// Waking when a session is saved, and uploading the ones there is no doubt about.
//
// HealthKit will launch this app in the background when a workout lands, which is the only
// way a recording reaches the server without the athlete opening anything. It needs the
// `com.apple.developer.healthkit.background-delivery` entitlement, which is in
// `WorkoutsMCP.entitlements`, and an observer registered on every launch — including the
// background ones, which is why `start()` is called from the app's own initialiser rather
// than from a view.
//
// It also needs delivery actually enabled, which is a separate thing that fails separately:
// HealthKit refuses it for a type nobody has authorised yet, and the initialiser runs before
// anybody has been asked. So `enableDelivery()` is its own step, re-tried rather than
// attempted once — see the note on it.
//
// What it does on waking is deliberately narrow. A session is uploaded only where the watch
// itself named the plan it was run against; the day-and-sport fallback the home screen uses
// is a guess, and a guess is fine when the athlete is looking at it and wrong when it files
// a session against a workout nobody chose. Everything else waits in the list.

import Foundation
import HealthKit

enum BackgroundSync {
    private static var observer: HKObserverQuery?
    private static var deliveryEnabled = false

    /// Idempotent: called on every launch, and the second call re-tries only what failed.
    static func start() {
        guard HKHealthStore.isHealthDataAvailable() else { return }

        if observer == nil {
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
        }

        enableDelivery()
    }

    /// Asking HealthKit to launch this app when a workout lands — the half that makes a wake
    /// happen at all, as opposed to the observer above, which is what answers one.
    ///
    /// Separate from the observer, and re-tried, because the two fail on different days.
    /// `enableBackgroundDelivery` throws for a type the athlete has not authorised, and on a
    /// first install that is every launch before they have been asked: `start()` runs in the
    /// app's initialiser and `HealthAccess.request()` runs from the first screen that needs
    /// it, so the very first launch asks in that order every time. Registering the observer
    /// once is right — it is cheap and it cannot fail that way. Giving up on delivery after
    /// one attempt was what left the app never woken, until some later cold launch happened
    /// to re-run this with authorization already granted.
    ///
    /// So it is called again wherever authorization has just been granted, and the flag is
    /// set only on success: a failure leaves it false so the next caller tries once more.
    static func enableDelivery() {
        guard HKHealthStore.isHealthDataAvailable(), !deliveryEnabled else { return }

        Task {
            do {
                try await HealthAccess.store.enableBackgroundDelivery(for: .workoutType(), frequency: .immediate)
                deliveryEnabled = true
            } catch {
                // Left false on purpose. There is nobody to tell in a background launch, and
                // the next launch — or the next time the athlete grants Health access — asks
                // again. What this used to do was swallow the error with nothing left to
                // re-try from, which is a failure that reports itself as an app that simply
                // never wakes.
            }
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
            guard let planID = await HealthAccess.planID(of: activity),
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
