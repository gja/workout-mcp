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

    /// Which of a plan is the watch's business: near enough to matter, and not already done.
    static func due(in workouts: [PlannedWorkout]) -> [PlannedWorkout] {
        workouts
            .filter { $0.date >= day(scheduleFrom) && $0.date <= day(scheduleTo) && !$0.isDone }
            .sorted { $0.date < $1.date }
    }

    /// Place them all, take off whatever the plan no longer has, and record that it happened.
    ///
    /// `placed` is called as each one lands so a foreground caller can count them out; a
    /// background one passes nothing and the loop is the same either way.
    @discardableResult
    static func place(
        _ due: [PlannedWorkout],
        using client: WorkoutsClient,
        placed: (Int) -> Void = { _ in }
    ) async throws -> Int {
        await WorkoutKitSync.authorize()

        var count = 0
        for (slot, workout) in due.enumerated() {
            let plan = try await client.plan(for: workout)
            try await WorkoutKitSync.schedule(plan, at: scheduledTime(for: workout, slot: slot))
            count += 1
            placed(count)
        }

        // Anything the plan no longer has is taken off the watch, so the two really do agree.
        await WorkoutKitSync.pruneTo(keys: Set(due.map(\.key)))

        let at = Date()
        UserDefaults.standard.set(at, forKey: syncedAtKey)
        UserDefaults.standard.set(count, forKey: syncedCountKey)
        return count
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
