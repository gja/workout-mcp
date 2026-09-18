// Recorded sessions this app is finished with: sent, refused for good, or never carrying a
// plan at all.
//
// The listing used to answer the first of those — `isDone` on the planned workout — but that
// is three weeks of plan over the slowest link in the path to settle one boolean, and a wake
// has seconds. Local, and written only where the answer cannot change: a session that failed
// for a reason another run might not hit is *not* here, so it is found again. See docs/ios.md.

import Foundation

enum Settled {
    private static let defaults = UserDefaults.standard
    private static let defaultsKey = "settled-activities"

    /// Comfortably past the window `recentActivities` reads, so nothing is forgotten while it
    /// can still be offered, and this stays a few dozen short strings.
    private static let keepDays = 30

    static func contains(_ activity: UUID) -> Bool { all()[activity.uuidString] != nil }

    static func settle(_ activity: UUID) {
        var done = all()
        done[activity.uuidString] = Date()
        defaults.set(pruned(done), forKey: defaultsKey)
    }

    private static func all() -> [String: Date] {
        defaults.dictionary(forKey: defaultsKey) as? [String: Date] ?? [:]
    }

    private static func pruned(_ done: [String: Date]) -> [String: Date] {
        guard let oldest = Calendar.current.date(byAdding: .day, value: -keepDays, to: Date()) else { return done }
        return done.filter { $0.value >= oldest }
    }
}
