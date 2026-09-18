// What ties a planned workout to the thing Apple ends up holding: one id, derived rather
// than allocated, and readable back out again.
//
// WorkoutKit's plan id is a UUID and nothing else, so `<date>/<id>` cannot be stored there
// as itself — but it fits, with room over, in the 122 bits a UUID leaves free. So it is
// written in rather than hashed, and a session recorded weeks later names its workout from
// the id alone. The index below is what older builds needed and the last resort now.

import CryptoKit
import Foundation

enum PlanLink {
    /// The alphabet `src/db.ts` draws a workout id from, in its order: an id is one byte a
    /// character here, so this is the whole of what packs.
    private static let alphabet = Array("0123456789bcdfghjkmnpqrstvwxyz")

    /// Says a UUID is one this app wrote a key into, as against one Apple or another app
    /// allocated that happens to carry the same version.
    private static let magic: UInt8 = 0x77

    /// The length `src/db.ts` draws a workout id at, which is what makes a key fit at all.
    private static let idLength = 8

    /// Every byte of a UUID that is not the version nibble or the variant bits, in order.
    /// Thirteen are spoken for — magic, four of date, eight of id — and the last is spare.
    private static let free = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15]

    /// The WorkoutKit plan id for a workout, the same one every time: scheduling a workout
    /// twice replaces the plan rather than adding a second copy of it to the watch.
    static func planID(for key: String) -> UUID {
        packed(key) ?? hashed(key)
    }

    /// Every id this app has ever derived for a key, preferred first.
    static func allIDs(for key: String) -> [UUID] {
        [packed(key), hashed(key)].compactMap { $0 }
    }

    /// The id a key already sits under on the watch, or the one it would be given.
    ///
    /// **A workout scheduled by an earlier build keeps its digest.** Changing how an id is
    /// derived would otherwise rewrite every workout on the watch on the first sync after an
    /// upgrade, for nothing an athlete would see — and the index below still reads those.
    /// What the new layout is for is the sessions ahead, which get it as they are scheduled.
    static func planID(for key: String, onWatch: Set<UUID>) -> UUID {
        allIDs(for: key).first(where: onWatch.contains) ?? planID(for: key)
    }

    /// The key back. The index first, because it is the one of the two that can be *corrected*
    /// — a workout moved to another day is followed there by `follow`, where the id packed
    /// into the plan still spells the day it was scheduled on. The id itself is the fallback,
    /// because it is the one of the two that cannot go missing.
    static func workoutKey(forPlan planID: UUID) -> String? {
        all()[planID.uuidString] ?? unpacked(planID)
    }

    /// Follows a workout the plan has moved to another day.
    ///
    /// The server keeps a workout's id when it moves one, so a link whose id appears in the
    /// plan under a different date is the same workout — and without this, the session
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

    // --- The key, in a UUID -----------------------------------------------------------

    /// Eight BCD digits for the day and one byte per id character. Nil for anything that
    /// does not fit — an id of another length, or a date that is not `yyyy-MM-dd` — which
    /// falls back to the hash and the index, as every key used to.
    private static func packed(_ key: String) -> UUID? {
        let parts = key.split(separator: "/")
        guard parts.count == 2, parts[0].count == 10 else { return nil }

        let digits = parts[0].filter { $0 != "-" }.compactMap { $0.wholeNumberValue }
        guard digits.count == 8, digits.allSatisfy({ (0 ... 9).contains($0) }) else { return nil }
        guard parts[1].count == idLength else { return nil }

        var payload: [UInt8] = [magic]
        for pair in stride(from: 0, to: digits.count, by: 2) {
            payload.append(UInt8(digits[pair]) << 4 | UInt8(digits[pair + 1]))
        }
        for character in parts[1] {
            guard let index = alphabet.firstIndex(of: character) else { return nil }
            payload.append(UInt8(index))
        }

        var bytes = [UInt8](repeating: 0, count: 16)
        for (slot, byte) in zip(free, payload) { bytes[slot] = byte }
        // Version 8 is the one RFC 4122 leaves for a custom layout, and it is also what tells
        // these apart from the version-5 ids `hashed` produces.
        return uuid(bytes, version: 0x80)
    }

    private static func unpacked(_ planID: UUID) -> String? {
        let bytes = withUnsafeBytes(of: planID.uuid) { Array($0) }
        guard bytes[6] & 0xF0 == 0x80 else { return nil }

        let payload = free.map { bytes[$0] }
        guard payload[0] == magic else { return nil }

        var day = ""
        for byte in payload[1 ... 4] {
            let (high, low) = (byte >> 4, byte & 0x0F)
            guard high < 10, low < 10 else { return nil }
            day += "\(high)\(low)"
        }

        var id = ""
        for byte in payload[5 ..< 5 + idLength] {
            guard Int(byte) < alphabet.count else { return nil }
            id.append(alphabet[Int(byte)])
        }

        return "\(day.prefix(4))-\(day.dropFirst(4).prefix(2))-\(day.suffix(2))/\(id)"
    }

    /// What every key used to get, and what one that will not pack still gets: a digest, so
    /// the id is stable, and an index entry, because a digest does not come apart again.
    private static func hashed(_ key: String) -> UUID {
        let digest = Array(SHA256.hash(data: Data("workout-mcp:\(key)".utf8)).prefix(16))
        return uuid(digest, version: 0x50)
    }

    private static func uuid(_ bytes: [UInt8], version: UInt8) -> UUID {
        var bytes = bytes
        bytes[6] = (bytes[6] & 0x0F) | version // so what comes out is a legal UUID
        bytes[8] = (bytes[8] & 0x3F) | 0x80 // and the RFC 4122 variant
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    // --- The index the other way ------------------------------------------------------

    private static let defaultsKey = "plan-links"

    /// How long a link is worth keeping. The server holds three weeks; a month covers that
    /// and the session recorded at the far end of it.
    private static let keepDays = 31

    /// Remembered when a workout is scheduled, so a session recorded weeks later still names
    /// the plan it was for. Only a key that would not pack needs this; it is written for all
    /// of them because the cost is a short string and the failure is a session nobody can file.
    static func remember(planID: UUID, for key: String) {
        var links = all()
        links[planID.uuidString] = key
        UserDefaults.standard.set(pruned(links), forKey: defaultsKey)
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
