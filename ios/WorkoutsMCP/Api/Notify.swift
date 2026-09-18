// Telling the athlete a session went up, when nothing of this app is on screen to say so.
//
// Local rather than push: the moment worth announcing is one this phone already knows about —
// a background `URLSession` reporting a transfer it finished — so there is no server in it, no
// APNs, no certificate and no device token. See docs/ios.md.

import UserNotifications

enum Notify {
    /// Asked for beside Health, on a foreground refresh. iOS prompts once ever, and a launch
    /// nobody is looking at is the wrong moment to ask anybody anything.
    static func ask() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
    }

    /// One line about a session the athlete stopped waiting for. Posted from whichever launch
    /// iOS made to report the transfer, which usually has no screen at all — and refused
    /// silently where notifications were never allowed, which is the right amount of fuss.
    ///
    /// In the athlete's words rather than the app's: *your walk "90s walk II" has been marked
    /// complete*, which is what the upload did. Both the name and the sport come back in the
    /// answer to the POST, so neither costs a request.
    ///
    /// No banner while the app is in front: without a `UNUserNotificationCenterDelegate` iOS
    /// suppresses one, and a screen that is already redrawing itself has said it better.
    static func uploaded(_ name: String?, sport: String?) {
        let noun = Sports.noun(sport)
        let content = UNMutableNotificationContent()
        content.title = "Workout synced"
        content.body = name.map { "Your \(noun) \u{201C}\($0)\u{201D} has been marked complete!" }
            ?? "Your \(noun) has been marked complete!"
        content.sound = .default

        // No trigger at all, which means as soon as iOS will show it.
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
