// What ties a planned workout to the thing Apple ends up holding: one id, derived rather
// than allocated, plus the index that reads it back.

import CryptoKit
import Foundation

enum PlanLink {
    /// The WorkoutKit plan id for a workout, derived from `<date>/<id>` so it is the same
    /// one every time: scheduling a workout twice replaces the plan rather than adding a
    /// second copy of it to the watch. Derived and not allocated, so nothing has to be read
    /// back out of the index before a workout can go to the watch.
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

    /// How long a link is worth keeping. The server holds three weeks; a month covers that
    /// and the session recorded at the far end of it.
    private static let keepDays = 31

    /// Remembered when a workout is scheduled, so a session recorded weeks later still names
    /// the plan it was for — the id is derivable, but only from a workout still in the listing.
    static func remember(planID: UUID, for key: String) {
        var links = all()
        links[planID.uuidString] = key
        UserDefaults.standard.set(pruned(links), forKey: defaultsKey)
    }

    static func workoutKey(forPlan planID: UUID) -> String? {
        all()[planID.uuidString]
    }

    /// Follows a workout the plan has moved to another day.
    ///
    /// The server keeps a workout's id when it moves one, so a link whose id appears in the
    /// plan under a different date is that same workout — and without this, the session
    /// already recorded against it names a date the workout is no longer on, and the upload
    /// 404s for as long as the link lasts. Ambiguity is left alone rather than guessed at:
    /// an id is only unique within a day, so two current keys sharing one move nothing.
    static func follow(_ keys: Set<String>) {
        var byID: [Substring: String] = [:]
        var ambiguous: Set<Substring> = []
        for key in keys {
            guard let id = key.split(separator: "/").last else { continue }
            if byID.updateValue(key, forKey: id) != nil { ambiguous.insert(id) }
        }

        var links = all()
        var followed = false
        for (planID, was) in links {
            guard let id = was.split(separator: "/").last, !ambiguous.contains(id),
                  let now = byID[id], now != was else { continue }
            links[planID] = now
            followed = true
        }
        guard followed else { return }
        UserDefaults.standard.set(links, forKey: defaultsKey)
    }

    /// Dropped by the date in the key rather than by count. A dictionary has no order, so
    /// trimming one by position throws away an arbitrary set — including, often enough, the
    /// link just written, which is the one thing here that must survive.
    private static func pruned(_ links: [String: String]) -> [String: String] {
        guard let oldest = Calendar.current.date(byAdding: .day, value: -keepDays, to: Date()) else { return links }
        let cutoff = WorkoutDate.string(oldest)

        return links.filter { _, key in
            // `<date>/<id>`; anything that is not is left alone rather than guessed about.
            guard let date = key.split(separator: "/").first, date.count == 10 else { return true }
            return String(date) >= cutoff
        }
    }

    static func all() -> [String: String] {
        UserDefaults.standard.dictionary(forKey: defaultsKey) as? [String: String] ?? [:]
    }
}
