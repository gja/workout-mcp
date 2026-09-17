// Which part of the plan goes to the watch, when each workout is scheduled for, and what
// comes off again.
//
// Two callers want exactly these rules: the app, when it is opened or the athlete taps, and
// iOS, when it grants `PlanRefresh` a turn with nobody looking. So they live here rather
// than in the model that draws the status line, and the model is left holding only the
// counting-out that a status line needs.

import Foundation

enum PlanSync {
    /// How much of the plan goes to the watch.
    ///
    /// Two days back as well as forward, because a day missed is a session still worth doing
    /// and it should not need the app to get it back. Seven ahead rather than the fortnight
    /// the server holds, because the far end of a fortnight is a plan that has not settled
    /// yet, and a watch full of it is a list to scroll past.
    static let scheduleFrom = -2
    static let scheduleTo = 7

    /// When a scheduled workout lands on the watch. Early enough to be there before a dawn run.
    static let scheduledHour = 5

    /// How long a sync stays good for, when nobody has asked for another one.
    ///
    /// The same four hours `PlanRefresh` asks iOS for a turn at, because it is the same
    /// question: a plan written this morning should reach the watch today, and nothing here
    /// is urgent to the minute. Opening the app used to sync on anything over half an hour,
    /// which on a plan that had not moved was a round trip a workout for no change at all.
    /// A tap is never asked this — the athlete asking is the answer.
    static let staleAfter: TimeInterval = 4 * 60 * 60

    private static let syncedAtKey = "last-synced-at"
    private static let syncedCountKey = "last-synced-count"

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
        guard let last = lastSynced else { return true }
        return Date().timeIntervalSince(last.at) >= staleAfter
    }

    /// Whether the plan in hand is something other than what reached the watch. Free to ask
    /// — the listing is already read — and it is why opening the app inside the four hours
    /// still syncs when a workout was added, edited or moved in the meantime.
    static func hasChanged(_ due: [PlannedWorkout]) -> Bool {
        let placed = PlanPlacement.all()
        guard Set(placed.keys) == Set(due.map(\.key)) else { return true }
        return slots(for: due).contains { placed[$0.workout.key] != PlanPlacement.fingerprint($0.workout, at: $0.time) }
    }

    /// Which of a plan is the watch's business: near enough to matter, and not already done.
    static func due(in workouts: [PlannedWorkout]) -> [PlannedWorkout] {
        workouts
            .filter { $0.date >= day(scheduleFrom) && $0.date <= day(scheduleTo) && !$0.isDone }
            .sorted { $0.date < $1.date }
    }

    /// A workout and the minute it is meant to be on the watch at.
    private struct Slot {
        let workout: PlannedWorkout
        let time: Date
    }

    private static func slots(for due: [PlannedWorkout]) -> [Slot] {
        due.enumerated().map { Slot(workout: $1, time: scheduledTime(for: $1, slot: $0)) }
    }

    /// Place what is not already there, take off whatever the plan no longer has, and record
    /// that it happened.
    ///
    /// Most syncs place nothing. A workout whose row the server has not rewritten, scheduled
    /// for the minute it is already scheduled for and still on the watch, would land exactly
    /// as it stands — so it is left alone, and neither the round trip for its plan nor the
    /// two writes to the scheduler are spent. What that leaves in the common case is the
    /// listing the caller already had and one read of the scheduler.
    ///
    /// `placed` is called as each one is dealt with so a foreground caller can count them
    /// out; a background one passes nothing and the loop is the same either way.
    @discardableResult
    static func place(
        _ due: [PlannedWorkout],
        using client: WorkoutsClient,
        placed: (Int) -> Void = { _ in }
    ) async throws -> Int {
        try await WorkoutKitSync.requireAuthorization()

        let wanted = slots(for: due)
        let onWatch = await WorkoutKitSync.scheduled()
        let already = PlanPlacement.all()

        // Read together rather than one after another: this is the slow part of a sync that
        // has work to do, and a week of workouts is a week of round trips to one server.
        let stale = wanted.filter {
            !PlanPlacement.holds($0.workout, at: $0.time, placed: already, onWatch: onWatch.ids)
        }
        let plans = try await fetch(stale, using: client)

        var count = 0
        for slot in wanted {
            if let plan = plans[slot.workout.key] {
                try await WorkoutKitSync.schedule(plan, at: slot.time, replacing: onWatch)
                PlanPlacement.remember(slot.workout, at: slot.time)
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
        }

        let at = Date()
        UserDefaults.standard.set(at, forKey: syncedAtKey)
        UserDefaults.standard.set(count, forKey: syncedCountKey)
        return count
    }

    /// The plans that have to be fetched, fetched at once. The server answers each from its
    /// own row, so there is nothing to serialise them for, and one after another is what a
    /// first sync — or the morning after a week was written — spends nearly all of its time
    /// on. The scheduler is still written to in order, one workout at a time.
    private static func fetch(_ slots: [Slot], using client: WorkoutsClient) async throws -> [String: ResolvedPlan] {
        guard !slots.isEmpty else { return [:] }

        return try await withThrowingTaskGroup(of: (String, ResolvedPlan).self) { group in
            for slot in slots {
                group.addTask {
                    let plan = try await client.plan(for: slot.workout)
                    return (slot.workout.key, plan)
                }
            }

            var plans: [String: ResolvedPlan] = [:]
            for try await (key, plan) in group { plans[key] = plan }
            return plans
        }
    }

    /// Early on the day it is planned for, and never in the past — which is where this
    /// morning is by the time anybody opens the app, and where the scheduler has nothing to
    /// show for it. A day already gone is scheduled for the next whole hour instead, which is
    /// what makes a session missed on Sunday reachable on Tuesday.
    ///
    /// The next *whole* hour rather than a minute from now, so a resync ten minutes later
    /// lands on the same time and the watch is not rewritten for nothing. And a minute apart
    /// per workout, so two missed days are two entries rather than one time carrying both.
    static func scheduledTime(for workout: PlannedWorkout, slot: Int) -> Date {
        let calendar = Calendar.current
        let planned = workout.day ?? Date()
        let early = calendar.date(bySettingHour: scheduledHour, minute: 0, second: 0, of: planned) ?? planned

        var hour = calendar.dateComponents([.year, .month, .day, .hour], from: Date())
        hour.hour = (hour.hour ?? 0) + 1
        let soon = calendar.date(from: hour) ?? Date()

        return max(early, soon).addingTimeInterval(Double(60 * slot))
    }

    private static func day(_ offset: Int) -> String {
        WorkoutDate.string(Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date())
    }
}
