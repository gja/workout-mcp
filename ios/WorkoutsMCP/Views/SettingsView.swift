// Who is signed in, the way out, a way into what the half of this app nobody watches has
// been doing, and the one reading of Health that is not about a single session.
//
// Everything about the plan itself — including whether it has reached Apple Fitness —
// belongs beside the plan, on the Planned tab. The sync log is the exception that proves
// it: it is not a fact about the plan, it is a fact about the app, and it is here because
// there is nowhere in a background launch to say it and nobody there to hear it.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: AppSession
    @State private var showingLog = false
    @State private var showingHeartRate = false

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
                    Button("Heart rate") { showingHeartRate = true }
                } footer: {
                    Text(
                        "A year of Health in the two figures heart rate zones are anchored to: "
                            + "what you rest at, and the highest you have been recorded working."
                    )
                }

                Section {
                    Button("Sync log") { showingLog = true }
                } footer: {
                    Text(
                        "HealthKit launches the app when a session is saved and uploads it, "
                            + "where the watch itself named the workout it was run against. "
                            + "The log says whether that is happening."
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
            .sheet(isPresented: $showingLog) { SyncLogView() }
            .sheet(isPresented: $showingHeartRate) { HeartRateView() }
        }
    }
}
