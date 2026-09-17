// One button. Everything it needs to ask is asked on the server's own consent page, by
// Google or by Apple, and this app never sees a password.

import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var session: AppSession

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 10) {
                Image(systemName: "figure.run")
                    .font(.system(size: 52))
                    .foregroundStyle(.tint)
                Text("WorkoutsMCP").font(.largeTitle.bold())
                Text("Your plan on your watch, and what you ran back again.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()

            VStack(spacing: 12) {
                Button {
                    Task { await session.signIn() }
                } label: {
                    Text(session.busy ? "Signing in…" : "Sign in")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .disabled(session.busy)

                if let problem = session.problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                Text(AppServer.host)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(28)
    }
}
