// The steps of the session being recorded, written down where the next process can find
// them.
//
// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import Foundation

/// A session outlives the app, and until this existed its plan did not: carrying one on after
/// a force-quit meant fetching the listing and then the plan again before the screen had a
/// step to show — two round trips, on a phone that is outdoors and may have no signal, to
/// recover something the app already had in hand when it started. What that produced when it
/// failed was a run screen with no steps on it at all.
///
/// One entry, overwritten each time a session starts and cleared when one saves. A stale one
/// is harmless: it is only ever read for the workout it names.
enum Underway {
    private static let defaultsKey = "underway-run"

    private struct Run: Codable {
        let key: String
        let steps: [RunStep]
    }

    static func remember(key: String, steps: [RunStep]) {
        guard let data = try? JSONEncoder().encode(Run(key: key, steps: steps)) else { return }
        UserDefaults.standard.set(data, forKey: defaultsKey)
    }

    /// The steps of this workout, or nil where what is written down is some other session's —
    /// which is not a reason to guess, since the plan can still be fetched.
    static func steps(forWorkout key: String) -> [RunStep]? {
        guard let data = UserDefaults.standard.data(forKey: defaultsKey),
              let run = try? JSONDecoder().decode(Run.self, from: data),
              run.key == key
        else { return nil }
        return run.steps
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: defaultsKey)
    }
}
#endif
