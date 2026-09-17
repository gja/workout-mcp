import SwiftUI

@main
struct WorkoutsMCPApp: App {
    @StateObject private var session = AppSession()

    var body: some Scene {
        WindowGroup {
            Group {
                if session.isSignedIn {
                    HomeView()
                } else {
                    SignInView()
                }
            }
            .environmentObject(session)
        }
    }
}
