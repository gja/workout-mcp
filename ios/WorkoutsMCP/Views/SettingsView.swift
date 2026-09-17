// Who is signed in, and the way out. Everything about the plan itself — including whether
// it has reached Apple Fitness — belongs beside the plan, on the Planned tab.

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
                    Button("Log out", role: .destructive) { session.signOut() }
                        .frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .task { await session.loadAccount() }
        }
    }
}
