// Pulling the plan in on a schedule, so the watch is current without the app having been
// opened. The other half of `Health/BackgroundSync.swift`: nothing wakes this one, since a
// workout added on the server is a change no device here hears about, so it asks iOS for a
// turn every hour.
//
// What it does with a turn is the same `PlanSync` a tap runs — different rules would be a
// watch that changed depending on which last ran — and it also runs
// `BackgroundSync.uploadWhatIsCertain()` on its way past, as a backstop for a wake that
// never arrived.

import BackgroundTasks
import Foundation
import UIKit

enum PlanRefresh {
    /// The same string as `BGTaskSchedulerPermittedIdentifiers` in `ios/Info.plist`:
    /// iOS refuses to register a task the bundle has not declared, and refuses at launch.
    static let identifier = "com.workouts-mcp.ios.plan-refresh"

    /// A floor, not a promise: iOS decides when a background refresh actually runs, and asking
    /// for sooner than this does not make it sooner. An hour rather than the four it was,
    /// because this is the backstop for a wake that never came, and four hours was the gap the
    /// session that prompted it sat in. A turn costs nothing where there is nothing to do:
    /// `uploadWhatIsCertain` is local until it has something to send, and the plan read behind
    /// it keeps its own four-hour staleness in `PlanSync`.
    static let interval: TimeInterval = 60 * 60

    private static var registered = false
    private static var rearming: NSObjectProtocol?

    /// Called from the app's own initialiser, like `BackgroundSync.start()`, because
    /// `BGTaskScheduler` will only take a handler registered before launching finishes —
    /// and because a background launch builds the App and no view at all.
    static func start() {
        guard !registered else { return }
        registered = true

        // False means the bundle does not declare this identifier, and there is nothing to
        // schedule against: submitting anyway would throw on every launch for no gain.
        let accepted = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            run(refresh)
        }
        guard accepted else {
            // Written down rather than swallowed: an app iOS will not take a task for is one
            // whose backstop silently does not exist, and the log is where that is asked.
            SyncLog.refreshRefused("the bundle does not declare \(identifier)")
            return
        }

        schedule()
        rearmOnBackgrounding()
    }

    /// One turn asks for the next. iOS holds at most one request per identifier and never
    /// repeats one on its own, so a turn that does not re-arm is the last one there is.
    ///
    /// **A request already waiting is left alone.** Submitting replaces it, and replacing it
    /// pushes its earliest date out by the whole interval — so an app opened twice in a
    /// morning, which submits on every launch and every backgrounding, kept moving the turn
    /// it was waiting for. Asked for is not the same as due, and only the first ask decides
    /// when.
    static func schedule() {
        BGTaskScheduler.shared.getPendingTaskRequests { waiting in
            let ours = waiting.first { $0.identifier == identifier }
            // No date at all means iOS may run it whenever it likes, which is never later
            // than the one below.
            guard let ours else { return submit() }
            guard let due = ours.earliestBeginDate, due > Date(timeIntervalSinceNow: interval) else { return }
            submit()
        }
    }

    /// The failure is recorded: submitting throws where the athlete has turned Background App
    /// Refresh off, and a `try?` there is the difference between a backstop that is not
    /// running and a backstop nobody can tell is not running.
    private static func submit() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        do {
            try BGTaskScheduler.shared.submit(request)
            SyncLog.refreshScheduled()
        } catch let refusal as BGTaskScheduler.Error where refusal.code == .unavailable {
            // The one refusal an athlete can do something about, so it is said in the words
            // the switch is labelled with rather than as `BGTaskSchedulerErrorDomain 1`.
            SyncLog.refreshRefused("Background App Refresh is off for this app")
        } catch {
            SyncLog.refreshRefused(SyncLog.describe(error))
        }
    }

    /// And asked for again every time the app leaves the screen, which is Apple's own advice
    /// and now costs nothing, since `schedule()` leaves a request that is already waiting
    /// alone. A request refused at launch — Background App Refresh off, or a phone in Low
    /// Power Mode — is otherwise never asked for again in that process, and the backstop stays
    /// missing for as long as the app is left open.
    private static func rearmOnBackgrounding() {
        guard rearming == nil else { return }

        rearming = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { _ in schedule() }
    }

    private static func run(_ task: BGAppRefreshTask) {
        // Before the work rather than after it: a turn that throws, or that iOS cuts short,
        // still leaves one behind it. `submit` and not `schedule`, because this turn is the
        // request that was pending, and because asking first is a round trip a turn iOS is
        // about to suspend may not get an answer to.
        submit()

        let work = Task {
            // The session first and unconditionally: the backstop for a wake `.immediate`
            // delivery did not deliver. Recorded with its outcome, because a turn whose
            // upload failed used to write nothing, which reads exactly like one that skipped it.
            let outcome = await BackgroundSync.uploadWhatIsCertain()
            SyncLog.refreshTurn(outcome.rawValue)

            let placed = await sync()
            task.setTaskCompleted(success: placed)
        }

        // A refresh gets seconds, and the app is killed rather than waited for.
        task.expirationHandler = { work.cancel() }
    }

    /// The plan, read and placed. Signed out, or a server that cannot be reached, is not
    /// recorded anywhere: there is nobody here to tell, and the status line would end up
    /// reporting a turn the athlete never asked for.
    private static func sync() async -> Bool {
        guard let client = StoredSession.load()?.client else { return false }
        // iOS grants a turn when it suits iOS, sometimes twice in a morning. A sync that
        // recent has nothing to add, and reading the plan to find out is the round trip
        // being saved.
        guard PlanSync.isStale else { return true }

        let window = PlanSync.window
        guard let workouts = try? await client.workouts(from: window.from, to: window.to) else { return false }
        return (try? await PlanSync.place(PlanSync.due(in: workouts), using: client)) != nil
    }
}
