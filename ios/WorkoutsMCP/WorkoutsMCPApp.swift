import SwiftUI
import UIKit

@main
struct WorkoutsMCPApp: App {
    @StateObject private var session = AppSession()

    init() {
        // Here rather than in a view: HealthKit launches this app in the background when a
        // session is saved, and a background launch builds the App and no view at all.
        BackgroundSync.start()
        // What tells the log a launch was watched. `scenePhase` was tried and is wrong for
        // this: SwiftUI builds the scene and reports `.active` even on a HealthKit background
        // launch, so every wake recorded itself as a foreground one. This notification is
        // posted only when the app genuinely comes to the front.
        NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { _ in SyncLog.becameActive() }
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
