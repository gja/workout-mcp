// Which part of the plan goes to the watch, when each workout is scheduled for, and what
// comes off again. Here rather than in the model, because two callers want exactly these
// rules: the app on a tap, and iOS when it grants `PlanRefresh` a turn with nobody looking.

import Foundation

enum PlanSync {
    /// Two days back as well as forward, because a day missed is a session still worth doing.
    /// Seven ahead rather than the fortnight the server holds: the far end of a fortnight is
    /// a plan that has not settled, and a watch full of it is a list to scroll past.
    static let scheduleFrom = -2
    static let scheduleTo = 7

    /// The same four hours `PlanRefresh` asks iOS for a turn at, because it is the same
    /// question: a plan written this morning should reach the watch today, and nothing here
    /// is urgent to the minute. A tap is never asked this.
    static let staleAfter: TimeInterval = 4 * 60 * 60

    private static let syncedAtKey = "last-synced-at"
    private static let syncedCountKey = "last-synced-count"
    private static let syncedBuildKey = "last-synced-build"

    /// The build that last placed the plan, against the build running now. `PlanPlacement`
    /// remembers what the *server* said, which cannot notice a new app reading the same plan
    /// into different steps — a fixed alert, a renamed step — so the watch would keep what
    /// the old build wrote until the server happened to rewrite the workout. One string in
    /// defaults is the whole of noticing, and it costs a read.
    private static var isNewBuild: Bool {
        UserDefaults.standard.string(forKey: syncedBuildKey) != build
    }

    private static var build: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown"
    }

    /// When the plan last reached the watch, and how much of it did. Written wherever a sync
    /// ran, so a turn iOS granted in the night is what the status line reports in the morning.
    static var lastSynced: (at: Date, count: Int)? {
        let defaults = UserDefaults.standard
        guard let at = defaults.object(forKey: syncedAtKey) as? Date else { return nil }
        return (at, defaults.integer(forKey: syncedCountKey))
    }

    /// The window a sync reads, as dates the server understands.
    static var window: (from: Date, to: Date) {
        let calendar = Calendar.current
        let now = Date()
        return (
            calendar.date(byAdding: .day, value: scheduleFrom, to: now) ?? now,
            calendar.date(byAdding: .day, value: scheduleTo, to: now) ?? now
        )
    }

    /// Whether a sync nobody asked for is worth running at all, knowing only when the last
    /// one was. What `PlanRefresh` has to go on: reading the plan is the round trip it would
    /// be avoiding, so it cannot look at the plan first.
    static var isStale: Bool {
        guard let last = lastSynced, !isNewBuild else { return true }
        return Date().timeIntervalSince(last.at) >= staleAfter
    }

    /// Whether the plan in hand is something other than what reached the watch. Free to ask
    /// — the listing is already read — and it is why opening the app inside the four hours
    /// still syncs when a workout was added, edited or moved in the meantime.
    static func hasChanged(_ due: [PlannedWorkout]) -> Bool {
        if isNewBuild { return true }
        let placed = PlanPlacement.all()
        guard Set(placed.keys) == Set(due.map(\.key)) else { return true }
        return due.contains { placed[$0.key] != PlanPlacement.fingerprint($0) }
    }

    /// Near enough to matter, done or not. A session already done goes out ticked, so the
    /// week on the watch is the week that was planned rather than what is left of it — and
    /// a session worth doing again is still there to start.
    static func due(in workouts: [PlannedWorkout]) -> [PlannedWorkout] {
        workouts
            .filter { $0.date >= day(scheduleFrom) && $0.date <= day(scheduleTo) }
            .sorted { $0.date < $1.date }
    }

    /// Place what is not already there, take off whatever the plan no longer has, and record
    /// that it happened.
    ///
    /// Most syncs place nothing: a workout the server has not rewritten, on the day it is
    /// already scheduled for and still on the watch, would land exactly as it stands, so
    /// neither its steps nor the two writes are spent on it. That leaves the listing the
    /// caller already had and one read of the scheduler.
    ///
    /// **`force` sends the window again whatever that record says**, and so does the first
    /// sync after an app update: the record is about the server's plan and cannot see a
    /// build that reads it into different steps. A tap is somebody saying the watch is
    /// wrong, and a new build is this app saying the same thing.
    ///
    /// `placed` is called per workout so a foreground caller can count them out.
    @discardableResult
    static func place(
        _ due: [PlannedWorkout],
        using client: WorkoutsClient,
        force: Bool = false,
        placed: (Int) -> Void = { _ in }
    ) async throws -> Int {
        try await WorkoutKitSync.requireAuthorization()

        let onWatch = await WorkoutKitSync.scheduled()
        let already = PlanPlacement.all()

        // One request for all of them: this is the slow part of a sync that has work to do,
        // and a week of workouts used to be a week of round trips to the same server.
        let everything = force || isNewBuild
        let stale = everything ? due : due.filter { !PlanPlacement.holds($0, placed: already, onWatch: onWatch) }
        let plans = try await client.plans(for: stale)

        var count = 0
        var written = 0
        for workout in due {
            if let plan = plans[workout.key] {
                try await WorkoutKitSync.schedule(
                    plan,
                    on: workout.day,
                    done: workout.isDone,
                    replacing: onWatch
                )
                PlanPlacement.remember(workout)
                written += 1
            }
            count += 1
            placed(count)
        }

        // Anything the plan no longer has is taken off the watch, so the two really do agree.
        // Only where something could have changed: the scheduler is read and written to here
        // as well, and a plan that is exactly what was last placed has nothing left over.
        let keys = Set(due.map(\.key))
        if !plans.isEmpty || Set(already.keys) != keys {
            await WorkoutKitSync.pruneTo(keys: keys, among: onWatch)
            PlanPlacement.keep(keys)
            // After the prune and not before it: the prune reads the same links to decide
            // what to take off the watch, and a link followed first would keep the old plan
            // there. The session already recorded under it is what this is for.
            PlanLink.follow(keys)
        }

        // `written`, not `count`: the latter counts the whole window so a caller can show
        // progress, and most of it is skipped.
        SyncLog.record(.plan, written == 0 ? "plan already on the watch" : "wrote \(written) to the watch")

        let at = Date()
        UserDefaults.standard.set(at, forKey: syncedAtKey)
        UserDefaults.standard.set(count, forKey: syncedCountKey)
        // Last of the three: a sync that threw on its way here has not finished putting
        // this build's steps on the watch, and the build it is replacing stays recorded.
        UserDefaults.standard.set(build, forKey: syncedBuildKey)
        return count
    }

    private static func day(_ offset: Int) -> String {
        WorkoutDate.string(Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date())
    }
}
