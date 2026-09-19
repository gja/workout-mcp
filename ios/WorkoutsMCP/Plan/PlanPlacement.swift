// What this app has already put on the watch, so a sync can tell what is left to do.
//
// Everything a scheduled workout is built from comes off the server, which says when it
// last wrote each workout — so remembering `updated_at` and the day scheduled for is enough
// to know which workouts would land exactly as they already are. A steady plan synced again
// an hour later is then a listing and one read of the scheduler.
//
// Checked against the scheduler rather than trusted on its own: a plan the athlete deleted
// in the Workout app is gone from the watch and still in here.

import Foundation

enum PlanPlacement {
    private static let defaultsKey = "plan-placements"

    /// Workout key to the fingerprint of what was placed for it.
    static func all() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }

    /// What has to still be true for the watch to be holding this workout as it stands: the
    /// same revision of it, on the same day.
    ///
    /// Nil where the server did not say when the workout was last written — a deployment
    /// older than this — and a fingerprint that does not exist never matches, so those
    /// deployments sync exactly as they did before.
    static func fingerprint(_ workout: PlannedWorkout) -> String? {
        guard let updated = workout.updatedAt else { return nil }
        return "\(updated)@\(workout.date)"
    }

    /// Placed as it now is, still on the watch, and ticked there if it is done here. The tick
    /// is checked against the scheduler for the same reason the plan is: a completion cleared
    /// in the Workout app is one this app's record would still claim.
    static func holds(
        _ workout: PlannedWorkout,
        placed: [String: String],
        onWatch: WorkoutKitSync.Schedule
    ) -> Bool {
        guard let wanted = fingerprint(workout), placed[workout.key] == wanted else { return false }
        let planID = PlanLink.planID(for: workout.key)
        return onWatch.ids.contains(planID) && onWatch.ticked.contains(planID) == workout.isDone
    }

    static func remember(_ workout: PlannedWorkout) {
        guard let fingerprint = fingerprint(workout) else { return }
        var placed = all()
        placed[workout.key] = fingerprint
        UserDefaults.standard.set(placed, forKey: defaultsKey)
    }

    /// Forgotten for the same workouts a prune takes off the watch, so this stays the size
    /// of the window rather than growing for the life of the app.
    static func keep(_ keys: Set<String>) {
        UserDefaults.standard.set(all().filter { keys.contains($0.key) }, forKey: defaultsKey)
    }
}
