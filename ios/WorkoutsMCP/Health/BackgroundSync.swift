// Waking when a session is saved, and uploading the ones there is no doubt about. See
// "And with the app shut" in docs/ios.md.
//
// Being woken is three things that fail on different days. The **observer** needs the
// `healthkit.background-delivery` entitlement and re-registering every launch — including
// background ones, hence `start()` from the app's initialiser: HealthKit remembers that
// delivery was enabled for the type across restarts, but not the callback. **Delivery**
// has to be enabled separately, and is refused for a type nobody has authorised yet, so
// `enableDelivery()` is re-tried rather than attempted once. And every **wake** has to be
// answered, or HealthKit reads the observer as not coping and stops waking the app — which
// is what `Wake` below exists for.
//
// What it does on waking is deliberately narrow: only where the watch itself named the
// plan. The day-and-sport fallback is a guess, fine when the athlete is looking at it and
// wrong when it files a session against a workout nobody chose.

import Foundation
import HealthKit
import UIKit

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
                    WakeLog.woke(.unreadable)
                    completion()
                    return
                }
                Task { @MainActor in await answer(completion) }
            }

            observer = query
            HealthAccess.store.execute(query)
        }

        enableDelivery()
    }

    /// What makes a wake happen at all, as against the observer, which answers one.
    ///
    /// Re-tried, because `enableBackgroundDelivery` throws for a type the athlete has not
    /// authorised — and on a first install that is every launch before they have been asked.
    /// So it is called again wherever authorization has just been granted, and the flag is
    /// set only on success.
    ///
    /// `.immediate` is a request rather than a promise: Low Power Mode and a watch that has
    /// not synced the session over both delay it, hence `PlanRefresh`'s backstop.
    static func enableDelivery() {
        guard HKHealthStore.isHealthDataAvailable(), !deliveryEnabled else { return }

        Task {
            do {
                try await HealthAccess.store.enableBackgroundDelivery(for: .workoutType(), frequency: .immediate)
                deliveryEnabled = true
                WakeLog.deliveryEnabled()
            } catch {
                // Left false on purpose, so the next launch — or the next grant of Health
                // access — asks again. Swallowed, this failure reports itself as an app that
                // simply never wakes, which is why it is also written down.
                WakeLog.deliveryRefused(error)
            }
        }
    }

    /// One wake, answered once: the acknowledgement is what keeps the next wake coming, and
    /// this is the only place that knows both it and the work.
    @MainActor
    private static func answer(_ completion: @escaping () -> Void) async {
        let wake = Wake(completion)
        wake.begin()

        let outcome = await uploadWhatIsCertain()
        WakeLog.woke(outcome)
        wake.done()
    }

    /// Answering the moment the callback returns would cut the upload off; answering only
    /// after it would, on the launch where iOS runs out of patience first, never answer at
    /// all. So the work runs under a background-task assertion, and whichever comes first —
    /// the work finishing, or the launch ending — acknowledges and releases it.
    @MainActor
    private final class Wake {
        private var acknowledge: (() -> Void)?
        private var assertion = UIBackgroundTaskIdentifier.invalid

        init(_ acknowledge: @escaping () -> Void) {
            self.acknowledge = acknowledge
        }

        func begin() {
            assertion = UIApplication.shared.beginBackgroundTask(withName: "session-upload") {
                // UIKit calls an expiration handler on the main thread, which is where this
                // object lives. This is the last moment there is to answer.
                MainActor.assumeIsolated {
                    WakeLog.woke(.ranOut)
                    self.done()
                }
            }
        }

        /// Exactly once, from either end.
        func done() {
            acknowledge?()
            acknowledge = nil

            guard assertion != .invalid else { return }
            UIApplication.shared.endBackgroundTask(assertion)
            assertion = .invalid
        }
    }

    /// Only the sessions the watch itself matched to a plan, and only the ones the server has
    /// not already read — `isDone` on the listing is what says so, so nothing needs a ledger
    /// and a failed upload is simply still not done.
    ///
    /// Not private, and not only for a wake: `PlanRefresh` and opening the app run it too,
    /// because `.immediate` delivery is a request rather than a guarantee.
    @discardableResult
    static func uploadWhatIsCertain() async -> WakeLog.Outcome {
        guard let client = StoredSession.load()?.client else { return .signedOut }

        let from = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
        let to = Calendar.current.date(byAdding: .day, value: 14, to: Date()) ?? Date()

        guard let planned = try? await client.workouts(from: from, to: to) else { return .unreachable }
        // Two days: a wake is for what just finished, and a background launch has
        // seconds rather than minutes to spend.
        guard let activities = try? await HealthAccess.recentActivities(days: 2) else { return .unreadable }

        var uploaded = 0
        var refused = false

        for activity in activities {
            // A turn iOS is about to take back. What is left is the next run's, and the
            // server's own record of what is done is what makes that safe.
            if Task.isCancelled { break }

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
                uploaded += 1
            } catch {
                // Continue, not return: one session that cannot be read or sent must not
                // hide every session behind it for as long as it stays stuck.
                refused = true
            }
        }

        if uploaded > 0 { WakeLog.uploaded(uploaded) }
        if refused { return .failed }
        return uploaded > 0 ? .uploaded : .nothing
    }
}
