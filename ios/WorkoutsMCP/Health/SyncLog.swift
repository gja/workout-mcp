// Every event the two sync halves produce, written down where somebody can look.
//
// A session missing from the server is equally consistent with HealthKit never having woken
// us, a wake cut short, and a session this app will not upload unattended — and there is
// nobody in a background launch to tell which. So each step records a line, and Settings
// shows the log. See docs/ios.md.

import Foundation

enum SyncLog {
    private static let defaults = UserDefaults.standard
    private static let entriesKey = "sync-log"
    private static let deliveryProblemKey = "sync-delivery-problem"
    private static let deliveryAtKey = "sync-delivery-at"
    private static let uploadedKey = "sync-uploaded-count"
    private static let backgroundKey = "sync-background-wake-count"

    /// The last hundred lines, not an archive. A run writes a handful, so this is days of
    /// ordinary use and still bounded on the day something logs in a loop.
    private static let limit = 100

    enum Kind: String, Codable {
        /// HealthKit's answer to being asked to wake this app.
        case delivery
        /// The observer fired — in the background, or on a launch that executed it.
        case wake
        /// A session went to the server, or would not.
        case upload
        /// The plan went out to the watch.
        case plan
    }

    /// How a wake ended. The wording is what the log shows, so it is the athlete's words
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

    struct Entry: Codable, Identifiable {
        let id: UUID
        let at: Date
        let kind: Kind
        let said: String
        /// Whether this happened with nobody looking — see `isUnattended`.
        let unattended: Bool
    }

    // --- Was anybody looking -------------------------------------------------------------

    private static var hasBeenActive = false

    /// Called when the app first reaches the screen. A background launch builds no view, so
    /// "this process was never active" is a fact that cannot be raced — where reading
    /// `UIApplication.applicationState` early in a HealthKit launch can still say `.inactive`
    /// and report a real background wake as a foreground one.
    static func becameActive() { hasBeenActive = true }

    /// Whether this process has run without ever being on screen.
    static var isUnattended: Bool { !hasBeenActive }

    // --- Writing ---------------------------------------------------------------------------

    /// Appended read-modify-write, so two of these at the same instant can lose one. That is
    /// the right trade for a diagnostic: a lock held across a background launch is not.
    static func record(_ kind: Kind, _ said: String) {
        var log = entries
        log.append(Entry(id: UUID(), at: Date(), kind: kind, said: said, unattended: isUnattended))
        log = pruned(log)

        if kind == .wake, isUnattended {
            defaults.set(defaults.integer(forKey: backgroundKey) + 1, forKey: backgroundKey)
        }
        guard let data = try? JSONEncoder().encode(log) else { return }
        defaults.set(data, forKey: entriesKey)
    }

    static func deliveryEnabled() {
        defaults.set(Date(), forKey: deliveryAtKey)
        defaults.removeObject(forKey: deliveryProblemKey)
        record(.delivery, "HealthKit will wake the app")
    }

    static func deliveryRefused(_ error: Error) {
        defaults.set(Date(), forKey: deliveryAtKey)
        defaults.set(error.localizedDescription, forKey: deliveryProblemKey)
        record(.delivery, "HealthKit refused to wake the app: \(describe(error))")
    }

    /// More than `localizedDescription`, which for a network failure is a sentence that names
    /// neither the status nor the code — and a log read at arm's length needs both.
    static func describe(_ error: Error) -> String {
        if let api = error as? ApiError { return "HTTP \(api.status) — \(api.message)" }
        let ns = error as NSError
        return "\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
    }

    private static func pruned(_ log: [Entry]) -> [Entry] {
        guard log.count > limit else { return log }
        return Array(log.dropFirst(log.count - limit))
    }

    /// Never reset, where the log above is trimmed: one session that went up without anybody
    /// tapping *Export*, ever, is the proof this path works at all.
    static func uploaded(_ count: Int) {
        defaults.set(defaults.integer(forKey: uploadedKey) + count, forKey: uploadedKey)
    }

    // --- Reading -----------------------------------------------------------------------------

    /// Oldest first, as they happened.
    static var entries: [Entry] {
        guard let data = defaults.data(forKey: entriesKey),
              let log = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return log
    }

    /// When background delivery was last asked for and what HealthKit said, or nil before
    /// anything has asked. A problem here explains every other silence: nothing downstream
    /// of it ever runs.
    static var delivery: (at: Date, problem: String?)? {
        guard let at = defaults.object(forKey: deliveryAtKey) as? Date else { return nil }
        return (at, defaults.string(forKey: deliveryProblemKey))
    }

    /// The last time iOS ran this app with nobody looking. The line that answers whether
    /// background delivery works, since no launch can produce one.
    static var lastBackgroundWake: Entry? {
        entries.last { $0.kind == .wake && $0.unattended }
    }

    /// How many times that has happened, ever: once is luck, not habit.
    static var backgroundWakes: Int { defaults.integer(forKey: backgroundKey) }

    /// Sessions this app has uploaded on its own, over its whole life.
    static var uploadedOnItsOwn: Int { defaults.integer(forKey: uploadedKey) }
}
