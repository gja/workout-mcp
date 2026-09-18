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
                    // Acknowledged first: HealthKit backs off an observer that stops
                    // answering, and writing it down can follow.
                    completion()
                    SyncLog.record(.wake, SyncLog.Outcome.unreadable.rawValue)
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
                SyncLog.deliveryEnabled()
            } catch {
                // Left false on purpose, so the next launch — or the next grant of Health
                // access — asks again. Swallowed, this failure reports itself as an app that
                // simply never wakes, which is why it is also written down.
                SyncLog.deliveryRefused(error)
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
        SyncLog.record(.wake, outcome.rawValue)
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
                    SyncLog.record(.wake, SyncLog.Outcome.ranOut.rawValue)
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

    /// Only the sessions the watch itself matched to a plan, and only the ones this app is
    /// not already finished with — `Settled` says so locally, because a wake has seconds and
    /// the listing that used to answer it is the slowest call in the path. Everything the
    /// POST needs is the workout key, which `PlanLink` already holds.
    ///
    /// Not private, and not only for a wake: `PlanRefresh` and opening the app run it too,
    /// because `.immediate` delivery is a request rather than a guarantee.
    ///
    /// **One run at a time.** Opening the app starts the observer's own fire and the catch-up
    /// within a moment of each other, and both used to reach the POST before either finished
    /// — one walk went up three times. `Settled` cannot stop that on its own, because none
    /// of them has recorded anything yet; a second caller joins the run already going instead.
    @discardableResult
    static func uploadWhatIsCertain() async -> SyncLog.Outcome {
        await join()
    }

    @MainActor private static var inFlight: Task<SyncLog.Outcome, Never>?

    @MainActor
    private static func join() async -> SyncLog.Outcome {
        if let running = inFlight { return await running.value }

        let run = Task { await send() }
        inFlight = run
        let outcome = await run.value
        inFlight = nil
        return outcome
    }

    private static func send() async -> SyncLog.Outcome {
        guard let client = StoredSession.load()?.client else { return .signedOut }

        let activities: [HKWorkout]
        do {
            // Two days: a wake is for what just finished, and a background launch has
            // seconds rather than minutes to spend.
            activities = try await HealthAccess.recentActivities(days: 2)
        } catch {
            SyncLog.record(.upload, "could not read Health: \(SyncLog.describe(error))")
            return .unreadable
        }

        var uploaded = 0
        var refused = false
        var unreachable = false
        // Counted so a run that sends nothing can say why, which is the silence that has been
        // hardest to read: three recent sessions and no upload is not one fact but three.
        var alreadySent = 0
        var unplanned = 0

        for activity in activities {
            // Cancellation reaches here when the run itself is cancelled; a caller that gave
            // up does not stop it, since another may still be waiting on the same run.
            if Task.isCancelled { break }

            // Before `planID`, which is a round trip to the store per session: the cheap
            // question first, so a wake spends its seconds on what it might actually send.
            guard !Settled.contains(activity.uuid) else { alreadySent += 1; continue }

            guard let planID = await HealthAccess.planID(of: activity) else {
                // Whether the watch named a plan is fixed when it records the session, so
                // this answer will not change — and asking costs a round trip to the store.
                Settled.settle(activity.uuid)
                unplanned += 1
                continue
            }
            // Not settled: this one *can* change, since scheduling the workout again writes
            // the link that is missing here.
            guard let key = PlanLink.workoutKey(forPlan: planID) else { unplanned += 1; continue }

            // Before the work, not only after it: reading the session, encoding the file and
            // posting it are where a wake runs out of time, and a line written only on
            // success leaves nothing behind to say which of them it died in.
            SyncLog.record(.upload, "about to upload \(key)")

            do {
                let recorded = try await SessionReader.read(activity, as: key)
                try await client.upload(
                    try ActivityFit.encode(recorded),
                    to: key,
                    activityID: activity.uuid.uuidString
                )
                Settled.settle(activity.uuid)
                uploaded += 1
                SyncLog.record(.upload, "finished uploading \(key)")
                // One a run. A wake is about the session that just finished, and the next
                // run — or the catch-up on opening the app — takes whatever is behind it.
                break
            } catch {
                // Continue, not return: one session that cannot be read or sent must not
                // hide every session behind it for as long as it stays stuck.
                SyncLog.record(.upload, "could not upload \(key): \(SyncLog.describe(error))")
                refused = true
                // Worth telling apart: a server that refused the file is a different morning
                // from a phone that had no network when it woke.
                if (error as NSError).domain == NSURLErrorDomain { unreachable = true }

                // A refusal another run would get the same answer to is not worth another
                // run. The listing used to filter a deleted workout out before it was ever
                // posted; without it, three deleted test workouts 404'd on every wake for a
                // day, because only a success was ever written down.
                if isPermanent(error) {
                    Settled.settle(activity.uuid)
                    SyncLog.record(.upload, "not offering \(key) again")
                }
            }
        }

        if uploaded == 0, !refused {
            SyncLog.record(
                .upload,
                "nothing to send: \(activities.count) recent, \(alreadySent) already up, \(unplanned) with no plan"
            )
        }

        if uploaded > 0 { SyncLog.uploaded(uploaded) }
        if refused { return unreachable ? .unreachable : .failed }
        return uploaded > 0 ? .uploaded : .nothing
    }

    /// Whether another run would get the same refusal. A workout deleted upstream, or a file
    /// this server will not take, is settled; 401 is not, because a credential can come back,
    /// and neither is a timeout, a rate limit or anything the network did.
    private static func isPermanent(_ error: Error) -> Bool {
        guard let api = error as? ApiError else { return false }
        return (400 ..< 500).contains(api.status) && ![401, 408, 429].contains(api.status)
    }
}
