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
// What it does on waking is deliberately narrow: only where the session itself names the
// plan — this app wrote the name in when it recorded the session, or the watch did. The
// day-and-sport fallback is a guess, fine when the athlete is looking at it and wrong when
// it files a session against a workout nobody chose.

import Foundation
import HealthKit
import UIKit

enum BackgroundSync {
    private static var observer: HKObserverQuery?
    private static var deliveryEnabled = false
    private static var unlock: NSObjectProtocol?

    /// Whether a run gave up because the phone was locked, so the unlock below is a trigger
    /// only where there is something to trigger — a phone is unlocked dozens of times a day
    /// and a query per unlock is what this app spends its budget avoiding everywhere else.
    /// In `UserDefaults` and not in memory: the wake that lost its turn happened in a process
    /// that is usually gone by the time anybody picks the phone up.
    private static var waitingOnUnlock: Bool {
        get { UserDefaults.standard.bool(forKey: "sync-waiting-on-unlock") }
        set { UserDefaults.standard.set(newValue, forKey: "sync-waiting-on-unlock") }
    }

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
        watchForUnlock()
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

    /// The other half of the guard in `send()`: a wake that arrives while the phone is locked
    /// is spent, because HealthKit does not send it again, and the session would otherwise
    /// wait for the next wake or for `PlanRefresh`'s turn some hours later. So the unlock is
    /// a trigger of its own, and the session goes the moment there is a passcode behind it.
    ///
    /// Registered at launch rather than from inside a wake: the process the lost wake
    /// happened in is long gone by the time anybody picks the phone up.
    ///
    /// Written down as an `.upload` and not a `.wake`, because iOS did not run this app —
    /// somebody unlocked it — and the count of background wakes is the one figure that says
    /// delivery works at all.
    private static func watchForUnlock() {
        guard unlock == nil else { return }

        unlock = NotificationCenter.default.addObserver(
            forName: UIApplication.protectedDataDidBecomeAvailableNotification,
            object: nil,
            queue: .main
        ) { _ in
            guard waitingOnUnlock else { return }
            Task {
                let outcome = await uploadWhatIsCertain()
                SyncLog.record(.upload, "unlocked — \(outcome.rawValue)")
            }
        }
    }

    /// The one question that can still be answered while the store cannot answer any.
    /// HealthKit encrypts what it holds with the passcode, so a launch on a locked phone can
    /// read nothing — and asking the store anyway is a round trip that ends in
    /// `[com.apple.healthkit 6]`.
    @MainActor
    private static var protectedDataAvailable: Bool { UIApplication.shared.isProtectedDataAvailable }

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

    /// Only the sessions that name the plan they were run against, and only the ones this app is
    /// not already finished with — `Settled` says so locally, because a wake has seconds and
    /// the listing that used to answer it is the slowest call in the path. Everything the
    /// POST needs is the workout key, which `PlanLink` already holds.
    ///
    /// **The POST itself is not waited for.** It goes to a background `URLSession`, which
    /// finishes it after this process is suspended; `Handed` keeps the next run from sending
    /// the same session again while it is in flight. See `SessionUpload`.
    ///
    /// Not private, and not only for a wake: `PlanRefresh`, opening the app and unlocking the
    /// phone on a wake that was lost to the lock all run it too, because `.immediate`
    /// delivery is a request rather than a guarantee.
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

        // Before the store rather than after it. Asked while the phone is locked, HealthKit
        // throws `Protected health data is inaccessible`, which reads in the log like a
        // failure and is not one: nothing is wrong, the data is behind the passcode until
        // somebody unlocks the phone — and `watchForUnlock` is what picks it up when they do.
        guard await protectedDataAvailable else {
            waitingOnUnlock = true
            SyncLog.record(.upload, "not reading Health: the phone is locked")
            return .locked
        }
        // Cleared here and not in the trigger: a run that gets this far has already done what
        // the unlock was going to ask for, whichever of the four callers started it.
        waitingOnUnlock = false

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
            guard !Settled.contains(activity.uuid), !Handed.contains(activity.uuid) else {
                alreadySent += 1
                continue
            }

            // A session this app recorded itself already says which workout it was, in its
            // own metadata, and saying so cost nothing — no round trip and no index. Asked
            // before `planID`, which is neither.
            var key = HealthAccess.recordedKey(of: activity)

            if key == nil {
                guard let planID = await HealthAccess.planID(of: activity) else {
                    // Whether the watch named a plan is fixed when it records the session, so
                    // this answer will not change — and asking costs a round trip to the store.
                    Settled.settle(activity.uuid)
                    unplanned += 1
                    continue
                }
                // Not settled: this one *can* change, since scheduling the workout again
                // writes the link that is missing here.
                key = PlanLink.workoutKey(forPlan: planID)
            }
            guard let key else { unplanned += 1; continue }

            // Before the work, not only after it: reading the session, encoding the file and
            // posting it are where a wake runs out of time, and a line written only on
            // success leaves nothing behind to say which of them it died in.
            SyncLog.record(.upload, "about to upload \(key)")

            do {
                let recorded = try await SessionReader.read(activity, as: key)
                // Timed on the way past: reading is measured inside `SessionReader`, and this
                // is the other half of the nine seconds a wake used to spend before the POST.
                let encoding = Date()
                let file = try ActivityFit.encode(recorded)
                let encoded = SyncLog.took(Date().timeIntervalSince(encoding))

                try await SessionUpload.shared.hand(file, to: key, activity: activity.uuid, using: client)
                Handed.hold(activity.uuid)
                uploaded += 1
                SyncLog.record(.upload, "handed \(key) to iOS to finish, encoded in \(encoded)")
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

        // Not counted here any more: the transfer is the system's now, and `SessionUpload`
        // counts it when the server has actually taken it.
        if refused { return unreachable ? .unreachable : .failed }
        return uploaded > 0 ? .handedOver : .nothing
    }

    /// Whether another run would get the same refusal. A workout deleted upstream, or a file
    /// this server will not take, is settled; 401 is not, because a credential can come back,
    /// and neither is a timeout, a rate limit or anything the network did.
    private static func isPermanent(_ error: Error) -> Bool {
        guard let api = error as? ApiError else { return false }
        return (400 ..< 500).contains(api.status) && ![401, 408, 429].contains(api.status)
    }
}
