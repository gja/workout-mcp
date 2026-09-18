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
    /// No banner while the app is in front: without a `UNUserNotificationCenterDelegate` iOS
    /// suppresses one, and a screen that is already redrawing itself has said it better.
    static func uploaded(_ name: String?) {
        let content = UNMutableNotificationContent()
        content.title = "Synced"
        content.body = name.map { "\($0) is on the server." } ?? "Your session is on the server."
        content.sound = .default

        // No trigger at all, which means as soon as iOS will show it.
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }
}
