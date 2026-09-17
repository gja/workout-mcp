// What this app has already put on the watch, so a sync can tell what is left to do.
//
// Everything a scheduled workout is built from comes off the server, and the server says
// when it last wrote each workout. So a sync that remembers `updated_at` and the minute it
// scheduled for knows, without asking anything, which workouts would land exactly as they
// already are — and those are the ones worth not sending. A steady plan, synced again an
// hour later, is then a listing and one read of the scheduler rather than a round trip and
// two writes per workout.
//
// Remembered rather than derived, and checked against the scheduler rather than trusted on
// its own: a plan the athlete deleted in the Workout app is gone from the watch and still
// in here, and putting it back is the whole point of looking.

import Foundation

enum PlanPlacement {
    private static let defaultsKey = "plan-placements"

    /// Workout key to the fingerprint of what was placed for it.
    static func all() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }

    /// What has to still be true for the watch to be holding this workout as it stands: the
    /// same revision of it, scheduled for the same minute.
    ///
    /// Nil where the server did not say when the workout was last written — a deployment
    /// older than this — and a fingerprint that does not exist never matches, so those
    /// deployments sync exactly as they did before.
    static func fingerprint(_ workout: PlannedWorkout, at time: Date) -> String? {
        guard let updated = workout.updatedAt else { return nil }
        return "\(updated)@\(Int(time.timeIntervalSince1970 / 60))"
    }

    /// Whether this workout can be left alone: placed as it now is, and still on the watch.
    static func holds(_ workout: PlannedWorkout, at time: Date, placed: [String: String], onWatch: Set<UUID>) -> Bool {
        guard let wanted = fingerprint(workout, at: time), placed[workout.key] == wanted else { return false }
        return onWatch.contains(PlanLink.planID(for: workout.key))
    }

    static func remember(_ workout: PlannedWorkout, at time: Date) {
        guard let fingerprint = fingerprint(workout, at: time) else { return }
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
