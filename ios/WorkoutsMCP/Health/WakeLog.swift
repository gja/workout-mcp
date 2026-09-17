// Whether the background half is alive, written down where somebody can look.
//
// A session missing from the server is equally consistent with HealthKit never having woken
// us, a wake that was cut short, and a session this app will not upload unattended — and
// there is nobody in a background launch to tell either way. So each half writes one line
// and Settings reads them back.
//
// `UserDefaults` rather than a log file: a wake happens in a process that is gone by the
// time anybody asks, and this is four short values.

import Foundation

enum WakeLog {
    private static let defaults = UserDefaults.standard

    // --- Whether HealthKit will wake us at all ------------------------------------------

    private static let deliveryAtKey = "wake-delivery-at"
    private static let deliveryProblemKey = "wake-delivery-problem"

    static func deliveryEnabled() {
        defaults.set(Date(), forKey: deliveryAtKey)
        defaults.removeObject(forKey: deliveryProblemKey)
    }

    static func deliveryRefused(_ error: Error) {
        defaults.set(Date(), forKey: deliveryAtKey)
        defaults.set(error.localizedDescription, forKey: deliveryProblemKey)
    }

    /// When background delivery was last asked for and what HealthKit said, or nil before
    /// anything has asked. A problem here is the one failure that explains every other
    /// silence, because nothing downstream of it ever runs.
    static var delivery: (at: Date, problem: String?)? {
        guard let at = defaults.object(forKey: deliveryAtKey) as? Date else { return nil }
        return (at, defaults.string(forKey: deliveryProblemKey))
    }

    // --- What a wake did with itself -----------------------------------------------------

    /// How a wake ended. The wording is what Settings shows, so it is the athlete's words
    /// rather than the code's: this is read by somebody asking why a session is not there.
    enum Outcome: String {
        case uploaded = "uploaded a session"
        case nothing = "nothing new to upload"
        case signedOut = "signed out"
        case unreachable = "could not reach the server"
        case unreadable = "could not read Health"
        case failed = "a session would not upload"
        case ranOut = "ran out of time"
    }

    private static let wokeAtKey = "wake-last-at"
    private static let wokeSaidKey = "wake-last-said"
    private static let uploadedKey = "wake-uploaded-count"

    static func woke(_ outcome: Outcome) {
        defaults.set(Date(), forKey: wokeAtKey)
        defaults.set(outcome.rawValue, forKey: wokeSaidKey)
    }

    /// Never reset: one session that went up without anybody tapping *Export*, ever, is the
    /// whole proof this path works, where an outcome is only the last one. Counts a wake, a
    /// `PlanRefresh` turn and the catch-up on opening the app alike, since they run the same
    /// rules; `lastWake` is what says which.
    static func uploaded(_ count: Int) {
        defaults.set(defaults.integer(forKey: uploadedKey) + count, forKey: uploadedKey)
    }

    /// When a wake last arrived and what it did, or nil if one never has.
    static var lastWake: (at: Date, said: String)? {
        guard let at = defaults.object(forKey: wokeAtKey) as? Date else { return nil }
        return (at, defaults.string(forKey: wokeSaidKey) ?? Outcome.nothing.rawValue)
    }

    /// Sessions this app has uploaded on its own, over its whole life.
    static var uploadedOnItsOwn: Int { defaults.integer(forKey: uploadedKey) }
}
