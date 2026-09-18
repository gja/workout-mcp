// Pulling the plan in on a schedule, so the watch is current without the app having been
// opened. The other half of `Health/BackgroundSync.swift`: nothing wakes this one, since a
// workout added on the server is a change no device here hears about, so it asks iOS for a
// turn every few hours.
//
// What it does with a turn is the same `PlanSync` a tap runs — different rules would be a
// watch that changed depending on which last ran — and it also runs
// `BackgroundSync.uploadWhatIsCertain()` on its way past, as a backstop for a wake that
// never arrived.

import BackgroundTasks
import Foundation

enum PlanRefresh {
    /// The same string as `INFOPLIST_KEY_BGTaskSchedulerPermittedIdentifiers` in the project:
    /// iOS refuses to register a task the bundle has not declared, and refuses at launch.
    static let identifier = "com.workouts-mcp.ios.plan-refresh"

    /// A floor, not a promise: iOS decides when a background refresh actually runs, and four
    /// hours is a request for "a few times a day". A plan written this morning should reach
    /// the watch today; nothing here is urgent to the minute.
    static let interval: TimeInterval = 4 * 60 * 60

    private static var registered = false

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
        if accepted { schedule() }
    }

    /// One turn asks for the next. iOS holds at most one request per identifier and never
    /// repeats one on its own, so a turn that does not re-arm is the last one there is.
    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        try? BGTaskScheduler.shared.submit(request)
    }

    private static func run(_ task: BGAppRefreshTask) {
        // Before the work rather than after it: a turn that throws, or that iOS cuts short,
        // still leaves one behind it.
        schedule()

        let work = Task {
            // The session first and unconditionally: the backstop for a wake `.immediate`
            // delivery did not deliver. Recorded with its outcome, because a turn whose
            // upload failed used to write nothing, which reads exactly like one that skipped it.
            let outcome = await BackgroundSync.uploadWhatIsCertain()
            SyncLog.record(.plan, "refresh turn — \(outcome.rawValue)")

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
