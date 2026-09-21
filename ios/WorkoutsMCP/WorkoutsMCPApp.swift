import SwiftUI
import UIKit

@main
struct WorkoutsMCPApp: App {
    @StateObject private var session = AppSession()
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    init() {
        // Here rather than in a view: HealthKit launches this app in the background when a
        // session is saved, and a background launch builds the App and no view at all.
        BackgroundSync.start()
        // Before anything can be handed over, and on every launch: until the session exists
        // iOS has nowhere to deliver a transfer it finished while this app was gone.
        SessionUpload.start()
        // What tells the log a launch was watched. `scenePhase` was tried and is wrong for
        // this: SwiftUI builds the scene and reports `.active` even on a HealthKit background
        // launch, so every wake recorded itself as a foreground one. This notification is
        // posted only when the app genuinely comes to the front.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in SyncLog.becameActive() }
        // And the way back out. Backgrounding does not end the process, so without this the
        // flag above is one-way and every wake for the rest of the app's life reads watched.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { _ in SyncLog.wentToBackground() }
        // The other direction, and the one nothing wakes: a turn asked of iOS every few hours
        // to read the plan. `BGTaskScheduler` takes a handler only before launching finishes.
        PlanRefresh.start()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if session.isSignedIn {
                    RootView()
                } else {
                    SignInView()
                }
            }
            .environmentObject(session)
        }
    }
}

/// The one thing SwiftUI has no hook for: iOS launching the app purely to say a background
/// transfer finished. The handler must be held and called once `SessionUpload` has taken
/// everything outstanding, or the launch is counted against the app.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        SessionUpload.start()
        SessionUpload.shared.whenDone = completionHandler
    }
}
