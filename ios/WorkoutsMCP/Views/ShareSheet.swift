// The system share sheet, and the one entry this app adds to it.
//
// SwiftUI's `ShareLink` cannot do either of the two things wanted here: it opens only when
// the athlete taps the link itself, and it carries no actions of its own. So the sheet is
// `UIActivityViewController` directly, which takes both — presented when the file is ready,
// with the upload sitting in the action row beside Mail, Files and AirDrop.

import SwiftUI
import UIKit

/// Posting the file to the server, offered as a share target.
///
/// It is a share target and nothing else, because that is where somebody who has just
/// watched a file appear is already looking, and a second button behind the sheet would be
/// two ways to do one thing. A sheet dismissed by accident costs a tap on *Share* again.
final class UploadActivity: UIActivity {
    private let title: String
    private let upload: () -> Void

    init(title: String, upload: @escaping () -> Void) {
        self.title = title
        self.upload = upload
        super.init()
    }

    override var activityType: UIActivity.ActivityType? {
        UIActivity.ActivityType("com.workouts-mcp.ios.upload")
    }

    override var activityTitle: String? { title }
    override var activityImage: UIImage? { UIImage(systemName: "arrow.up.circle") }

    /// The action row rather than the row of people and apps: this sends the session
    /// somewhere the athlete already has, and is not another copy going out.
    override class var activityCategory: UIActivity.Category { .action }

    override func canPerform(withActivityItems activityItems: [Any]) -> Bool { true }
    override func prepare(withActivityItems activityItems: [Any]) {}

    /// Finished as soon as the upload is under way rather than when it lands. The sheet is in
    /// front of the screen that reports how it went, and holding it open until the server
    /// answers would hide the answer behind it.
    override func perform() {
        upload()
        activityDidFinish(true)
    }
}

/// A written file, while the sheet sharing it is up. `.sheet(item:)` wants something
/// identifiable, and this is also the whole lifetime the app gives one: the URL is not held
/// after the sheet closes, so the next share writes the file again against whatever workout
/// the session is matched to by then.
///
/// The bytes stay in the temporary directory rather than being deleted on dismissal. A share
/// target copies asynchronously — AirDrop and Mail are still reading after the sheet is gone
/// — and pulling the file out from under them would fail the share to save a few hundred
/// kilobytes that iOS reclaims on its own. The name is settled by the session and the workout
/// it was for, so sharing the same session twice overwrites rather than accumulates.
struct BuiltFit: Identifiable {
    let url: URL

    var id: String { url.path }
}

/// `UIActivityViewController`, for a SwiftUI `.sheet`.
struct ShareSheet: UIViewControllerRepresentable {
    let item: URL
    var activities: [UIActivity] = []

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [item], applicationActivities: activities)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
