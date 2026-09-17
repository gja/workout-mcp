// The one thing to ask for is which deployment: workout-mcp is something you host, so
// there is no address to assume. Everything after that is Google's or Apple's own page.

import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var session: AppSession
    @AppStorage("server") private var server = ""
    @State private var showingToken = false
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("workouts.example.com", text: $server)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Your WorkoutsMCP server")
                } footer: {
                    Text("The address you open the dashboard at.")
                }

                Section {
                    Button("Sign in") {
                        Task { await session.signIn(to: server) }
                    }
                    .disabled(server.isEmpty || session.busy)
                }

                Section {
                    if showingToken {
                        SecureField("wk_…", text: $token)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button("Use this token") {
                            Task { await session.signIn(to: server, withToken: token) }
                        }
                        .disabled(server.isEmpty || token.isEmpty || session.busy)
                    } else {
                        Button("Use an API token instead") { showingToken = true }
                    }
                } footer: {
                    Text("Mint one on the dashboard under API tokens, if signing in through the browser is not an option.")
                }

                if let problem = session.problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle("WorkoutsMCP")
            .disabled(session.busy)
            .overlay { if session.busy { ProgressView() } }
        }
    }
}
