// Waking when a session is saved, and uploading the ones there is no doubt about.
//
// HealthKit will launch this app in the background when a workout lands, which is the only
// way a recording reaches the server without the athlete opening anything. It needs the
// `com.apple.developer.healthkit.background-delivery` entitlement, which is in
// `WorkoutsMCP.entitlements`, and an observer registered on every launch — including the
// background ones, which is why `start()` is called from the app's own initialiser rather
// than from a view. HealthKit remembers that delivery was enabled for the type across
// process restarts; it does not remember the callback, so that has to be re-executed every
// launch.
//
// It also needs delivery actually enabled, which is a separate thing that fails separately:
// HealthKit refuses it for a type nobody has authorised yet, and the initialiser runs before
// anybody has been asked. So `enableDelivery()` is its own step, re-tried rather than
// attempted once — see the note on it.
//
// And it needs every wake answered. HealthKit hands the observer a completion block and
// treats an observer that does not call it as one that is not coping: it backs off how
// eagerly it wakes the app and then stops. The work here — a listing, the session read out
// of Health, a FIT file written and posted — can outlast what iOS grants a background
// launch, so the acknowledgement is owned by `Wake` below and made exactly once, when the
// work finishes or when iOS says the launch is over, whichever comes first. Held until
// after the upload and no further, it was one slow round trip away from turning itself off
// silently, which is indistinguishable from never having been woken at all.
//
// What it does on waking is deliberately narrow. A session is uploaded only where the watch
// itself named the plan it was run against; the day-and-sport fallback the home screen uses
// is a guess, and a guess is fine when the athlete is looking at it and wrong when it files
// a session against a workout nobody chose. Everything else waits in the list.

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
    ///
    /// `.immediate` is a request rather than a promise. Low Power Mode, a watch that has not
    /// synced the session over yet, and the system's own view of what this app is worth
    /// waking all delay it, which is why `PlanRefresh` carries a backstop.
    static func enableDelivery() {
        guard HKHealthStore.isHealthDataAvailable(), !deliveryEnabled else { return }

        Task {
            do {
                try await HealthAccess.store.enableBackgroundDelivery(for: .workoutType(), frequency: .immediate)
                deliveryEnabled = true
                WakeLog.deliveryEnabled()
            } catch {
                // Left false on purpose. There is nobody to tell in a background launch, and
                // the next launch — or the next time the athlete grants Health access — asks
                // again. What this used to do was swallow the error with nothing left to
                // re-try from, which is a failure that reports itself as an app that simply
                // never wakes. It is written down now for the same reason.
                WakeLog.deliveryRefused(error)
            }
        }
    }

    /// One wake, answered once.
    ///
    /// The acknowledgement is what keeps the next wake coming, and the work is what the wake
    /// was for; this is the only place that knows both, so it is the only place that can
    /// promise the first happens whether or not the second finishes.
    @MainActor
    private static func answer(_ completion: @escaping () -> Void) async {
        let wake = Wake(completion)
        wake.begin()

        let outcome = await uploadWhatIsCertain()
        WakeLog.woke(outcome)
        wake.done()
    }

    /// The acknowledgement HealthKit is owed, and the assertion that buys time to earn it.
    ///
    /// Answering the moment the callback returns would cut the upload off; answering only
    /// after it would, on the launch where iOS runs out of patience first, never answer at
    /// all. So the work runs under a background-task assertion, and whichever comes first —
    /// the work finishing, or iOS saying the launch is over — acknowledges and releases it.
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
    /// not already read. A completion is what says it has: `isDone` comes back true on the
    /// listing once a recording has been ingested, so nothing needs a ledger of its own —
    /// and a session that failed to upload is simply still not done, so the next run picks it
    /// up rather than having been marked past before it was sent.
    ///
    /// Not private, and not only for a wake. `PlanRefresh` runs this too, and so does opening
    /// the app: `.immediate` delivery is a request rather than a guarantee, and a wake that
    /// iOS delays, cuts short or — after a force-quit — never sends at all would otherwise
    /// leave the session sitting on the phone with nothing due to look at it again.
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
                // The next run tries again, and the rest of this list is still worth trying:
                // one session that cannot be read or sent is not a reason to leave the one
                // behind it unsent too. This used to return, so a single stuck session hid
                // every session after it for as long as it stayed stuck.
                refused = true
            }
        }

        if uploaded > 0 { WakeLog.uploaded(uploaded) }
        if refused { return .failed }
        return uploaded > 0 ? .uploaded : .nothing
    }
}
