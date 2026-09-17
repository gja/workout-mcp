// Who is signed in, the way out, and whether the half of this app nobody watches is alive.
//
// Everything about the plan itself — including whether it has reached Apple Fitness —
// belongs beside the plan, on the Planned tab. The background section is the exception that
// proves it: it is not a fact about the plan, it is a fact about the app, and it is here
// because there is nowhere in a background launch to say it and nobody there to hear it.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.scenePhase) private var phase

    /// State rather than read in the body: `UserDefaults` is not observable, so a body that
    /// reads it holds its first reading while the catch-up it reports on finishes underneath.
    @State private var background = BackgroundFacts()

    var body: some View {
        NavigationStack {
            List {
                Section("Account") {
                    if let email = session.account?.email {
                        LabeledContent("Signed in as", value: email)
                    }
                    LabeledContent("Server", value: AppServer.host)
                }

                Section {
                    LabeledContent("Health can wake the app", value: background.delivery)
                    LabeledContent("Last background wake", value: background.lastBackgroundWake)
                    LabeledContent("Last observer fire", value: background.lastWake)
                    LabeledContent("Uploaded on its own", value: background.uploaded)
                } header: {
                    Text("In the background")
                } footer: {
                    Text(
                        "HealthKit launches the app when a session is saved and uploads it, "
                            + "where the watch itself named the workout it was run against. "
                            + "Force-quitting the app stops iOS sending those until it is opened again.\n\n"
                            + "Opening the app fires the observer too, so only the background line "
                            + "answers whether iOS is waking it."
                    )
                }

                Section {
                    Button("Log out", role: .destructive) { session.signOut() }
                        .frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .task { await session.loadAccount() }
            // The catch-up runs on the launch that opened this, so the first draw goes stale.
            .onAppear { background = BackgroundFacts() }
            .onChange(of: phase) { _, now in
                if now == .active { background = BackgroundFacts() }
            }
        }
    }
}

/// One reading of `WakeLog`, taken together, so the four lines on screen are four facts from
/// the same moment rather than four reads that can disagree. See docs/ios.md.
private struct BackgroundFacts {
    let delivery: String
    let lastWake: String
    let lastBackgroundWake: String
    let uploaded: String

    init() {
        // A problem here explains every other silence: nothing downstream of it ever runs.
        if let asked = WakeLog.delivery {
            delivery = asked.problem ?? "yes"
        } else {
            delivery = "not asked yet"
        }

        lastWake = Self.said(WakeLog.lastWake)
        // The only line a launch cannot write, so the only evidence iOS ran the app unasked.
        let background = Self.said(WakeLog.lastBackgroundWake)
        let count = WakeLog.backgroundWakes
        lastBackgroundWake = count > 1 ? "\(background) · \(count) in all" : background
        uploaded = "\(WakeLog.uploadedOnItsOwn)"
    }

    private static func said(_ wake: (at: Date, said: String)?) -> String {
        guard let wake else { return "never" }
        return "\(Formats.since(wake.at)) — \(wake.said)"
    }
}
