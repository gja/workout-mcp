import SwiftUI

@main
struct WorkoutsMCPApp: App {
    @StateObject private var session = AppSession()
    @Environment(\.scenePhase) private var phase

    init() {
        // Here rather than in a view: HealthKit launches this app in the background when a
        // session is saved, and a background launch builds the App and no view at all.
        BackgroundSync.start()
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
            // A background launch never reaches `.active`, which is what lets the log tell a
            // wake nobody saw from the one that opening the app causes. See `SyncLog`.
            .onChange(of: phase, initial: true) { _, now in
                if now == .active { SyncLog.becameActive() }
            }
        }
    }
}
