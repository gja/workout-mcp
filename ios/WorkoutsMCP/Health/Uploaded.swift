// Which recorded sessions have already reached the server.
//
// The listing used to answer this — `isDone` on the planned workout — but that is three
// weeks of plan fetched over the slowest link in the path to settle one boolean, and a wake
// has seconds. Written only after a POST succeeds, so a session that failed is simply not
// here and the next run finds it again: a watermark that cannot advance past an unsent
// session. See docs/ios.md.

import Foundation

enum Uploaded {
    private static let defaults = UserDefaults.standard
    private static let defaultsKey = "uploaded-activities"

    /// Comfortably past the window `recentActivities` reads, so nothing is forgotten while
    /// it can still be offered, and this stays a few dozen short strings.
    private static let keepDays = 30

    static func contains(_ activity: UUID) -> Bool { all()[activity.uuidString] != nil }

    static func remember(_ activity: UUID) {
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
