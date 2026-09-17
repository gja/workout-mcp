// What ties a planned workout to the thing Apple ends up holding: one id, derived rather
// than allocated, plus the index that survives the workout ageing out of the plan.

import CryptoKit
import Foundation

enum PlanLink {
    /// The WorkoutKit plan id for a workout, derived from `<date>/<id>` so it is the same
    /// one every time: scheduling a workout twice replaces the plan rather than adding a
    /// second copy of it to the watch.
    static func planID(for key: String) -> UUID {
        var digest = Array(SHA256.hash(data: Data("workout-mcp:\(key)".utf8)).prefix(16))
        digest[6] = (digest[6] & 0x0F) | 0x50 // version 5, so what comes out is a legal UUID
        digest[8] = (digest[8] & 0x3F) | 0x80 // and the RFC 4122 variant
        return UUID(uuid: (
            digest[0], digest[1], digest[2], digest[3], digest[4], digest[5], digest[6], digest[7],
            digest[8], digest[9], digest[10], digest[11], digest[12], digest[13], digest[14], digest[15]
        ))
    }

    // --- The index the other way ------------------------------------------------------

    private static let defaultsKey = "plan-links"

    /// Remembered when a workout is scheduled, so a session recorded weeks later still names
    /// the plan it was for — the id is derivable, but only from a workout still in the listing.
    static func remember(planID: UUID, for key: String) {
        var links = all()
        links[planID.uuidString] = key
        // Keeping the last few hundred is plenty: the server only holds three weeks anyway.
        if links.count > 500 { links = Dictionary(uniqueKeysWithValues: Array(links.suffix(400))) }
        UserDefaults.standard.set(links, forKey: defaultsKey)
    }

    static func workoutKey(forPlan planID: UUID) -> String? {
        all()[planID.uuidString]
    }

    static func all() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }
}
