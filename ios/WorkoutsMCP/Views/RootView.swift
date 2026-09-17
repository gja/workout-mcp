// The three tabs, and the one model behind them.
//
// Planned and Executed are the two halves of the same week — what is coming and what was
// done — and Settings is everything that is neither: where the plan stands with Apple
// Fitness, who is signed in, and the way out.

import SwiftUI

struct RootView: View {
    @EnvironmentObject private var session: AppSession
    @StateObject private var model = AppModel()

    var body: some View {
        TabView {
            PlannedView()
                .tabItem { Label("Planned", systemImage: "calendar") }

            ExecutedView()
                .tabItem { Label("Executed", systemImage: "checkmark.seal") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .environmentObject(model)
        .task { await model.refreshAndSyncIfStale(using: session.client) }
        // At the root rather than on the screen that starts it: an upload finishes after the
        // athlete has moved on, and the answer should reach them wherever they are.
        .alert("Done", isPresented: Binding(
            get: { model.note != nil },
            set: { shown in if !shown { model.note = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.note ?? "")
        }
    }
}

/// Whatever went wrong last, where it will be seen. Silent when nothing did.
struct ProblemRow: View {
    let problem: String?

    var body: some View {
        if let problem {
            Section { Text(problem).foregroundStyle(.red).font(.callout) }
        }
    }
}
