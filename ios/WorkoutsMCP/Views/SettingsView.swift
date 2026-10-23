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
    @State private var showingConnect = false
    #if ON_PHONE_RECORDING
    @State private var showingSensors = false
    #endif
    @State private var confirmingDelete = false
    #if ON_PHONE_RECORDING
    @AppStorage(RunVoice.defaultsKey) private var speaking = true
    #endif

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
                    Button("Connect to Claude") { showingConnect = true }
                } footer: {
                    Text("Step by step: add this server to Claude, then plan from the Claude iPhone app.")
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

                // With phone recording, which is what reads them: neither ships in a Release build.
                #if ON_PHONE_RECORDING
                Section {
                    Button("Bluetooth sensors") { showingSensors = true }
                } footer: {
                    Text("Connect a heart rate strap or a power meter and see its readings.")
                }
                #endif

                #if ON_PHONE_RECORDING
                Section {
                    Toggle("Speak the intervals", isOn: $speaking)
                } footer: {
                    Text(
                        "While recording a session on this phone: each interval and what it "
                            + "is aimed at, five seconds before a timed one ends, and when a "
                            + "reading leaves the band or comes back to it. Music is turned "
                            + "down rather than stopped."
                    )
                }
                #endif

                Section {
                    Button("Log out", role: .destructive) { session.signOut() }
                        .frame(maxWidth: .infinity)
                }

                Section {
                    Button("Delete account", role: .destructive) { confirmingDelete = true }
                        .frame(maxWidth: .infinity)
                        .disabled(session.busy)
                } footer: {
                    if let problem = session.problem {
                        Text(problem).foregroundStyle(.red)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .task { await session.loadAccount() }
            .sheet(isPresented: $showingLog) { SyncLogView() }
            .sheet(isPresented: $showingHeartRate) { HeartRateView() }
            .sheet(isPresented: $showingConnect) { ConnectClaudeView() }
            #if ON_PHONE_RECORDING
            .sheet(isPresented: $showingSensors) { SensorLabView() }
            #endif
            .confirmationDialog("Delete your account?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { Task { await session.deleteAccount() } }
            } message: {
                Text(
                    "Your plan, recorded sessions, notes and connections are deleted from the server, "
                        + "and the workouts this app put on your watch are removed. This cannot be undone. "
                        + "Sessions already saved in Health stay there."
                )
            }
        }
    }
}
