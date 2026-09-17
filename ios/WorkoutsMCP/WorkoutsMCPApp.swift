import SwiftUI

@main
struct WorkoutsMCPApp: App {
    @StateObject private var session = AppSession()

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
        }
    }
}
