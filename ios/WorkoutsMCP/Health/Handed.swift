// Sessions given to iOS to upload and not yet answered for.
//
// `Settled` is for what this app is finished with; this is the gap before that, which only
// exists because the transfer outlives the wake that started it. Without it every wake in the
// meantime would read the session as still missing and hand over a second copy.
//
// Held for hours rather than for ever: a transfer iOS quietly loses — a launch killed mid
// flight, a system that never reports back — would otherwise be a session nobody ever offers
// again. See docs/ios.md.

import Foundation

enum Handed {
    private static let defaults = UserDefaults.standard
    private static let defaultsKey = "handed-activities"

    /// Long enough that a transfer waiting on a network is not sent twice, short enough that
    /// a morning's session is still found the same morning.
    private static let keepHours = 6

    static func contains(_ activity: UUID) -> Bool {
        guard let at = all()[activity.uuidString] else { return false }
        return at >= Date().addingTimeInterval(-Double(keepHours) * 3600)
    }

    static func hold(_ activity: UUID) {
        var held = all()
        held[activity.uuidString] = Date()
        defaults.set(pruned(held), forKey: defaultsKey)
    }

    /// Answered for, one way or the other — `Settled` decides whether it comes back.
    static func release(_ activity: UUID) {
        var held = all()
        held.removeValue(forKey: activity.uuidString)
        defaults.set(pruned(held), forKey: defaultsKey)
    }

    private static func all() -> [String: Date] {
        defaults.dictionary(forKey: defaultsKey) as? [String: Date] ?? [:]
    }

    private static func pruned(_ held: [String: Date]) -> [String: Date] {
        let oldest = Date().addingTimeInterval(-Double(keepHours) * 3600)
        return held.filter { $0.value >= oldest }
    }
}
