// Who is signed in, the way out, and whether the half of this app nobody watches is alive.
//
// Everything about the plan itself — including whether it has reached Apple Fitness —
// belongs beside the plan, on the Planned tab. The background section is the exception that
// proves it: it is not a fact about the plan, it is a fact about the app, and it is here
// because there is nowhere in a background launch to say it and nobody there to hear it.

import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var session: AppSession

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
                    LabeledContent("Health can wake the app", value: delivery)
                    LabeledContent("Last woken", value: lastWake)
                    LabeledContent("Uploaded on its own", value: "\(WakeLog.uploadedOnItsOwn)")
                } header: {
                    Text("In the background")
                } footer: {
                    Text(
                        "HealthKit launches the app when a session is saved and uploads it, "
                            + "where the watch itself named the workout it was run against. "
                            + "Force-quitting the app stops iOS sending those until it is opened again."
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
        }
    }

    // --- The background half, in words -------------------------------------------------
    //
    // This section exists because the alternative is a guess. A session that is not on the
    // server is equally consistent with HealthKit never having woken the app, with a wake
    // that was cut short, and with a session this app will not upload unattended — and none
    // of those can say so from a background launch. These three lines separate them.

    /// Whether HealthKit accepted the request to launch this app. A problem here is the one
    /// failure that explains every other silence, since nothing downstream of it ever runs.
    private var delivery: String {
        guard let asked = WakeLog.delivery else { return "not asked yet" }
        return asked.problem ?? "yes"
    }

    private var lastWake: String {
        guard let wake = WakeLog.lastWake else { return "never" }
        return "\(Formats.since(wake.at)) — \(wake.said)"
    }
}
