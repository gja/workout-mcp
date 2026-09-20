// A button per sign-in the deployment offers. Apple's is its own sheet, over this screen;
// the others open the browser on that provider rather than on a page asking what this one
// just asked. Everything they want is asked there, and this app never sees a password. Why
// the list is the server's, and what the plain button falls back to, is in docs/ios.md.

import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var pressed: String?
    @State private var showingHeartRate = false

    /// Ours, not the server's — the dashboard keeps its own in `SignIn.tsx`.
    private static let labels = [
        "google": "Continue with Google",
        "apple": "Continue with Apple",
        "intervals": "Continue with intervals.icu",
    ]

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
                if session.providers.isEmpty {
                    button(labelled: "Sign in", for: nil)
                } else {
                    ForEach(session.providers, id: \.self) { provider in
                        if provider == "apple", session.nativeProviders.contains(provider) {
                            appleButton
                        } else {
                            button(labelled: Self.labels[provider] ?? "Continue with \(provider)", for: provider)
                        }
                    }
                }

                if let problem = session.problem {
                    Text(problem)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }

                // Reads Health and asks the server nothing, so there is no account for it to
                // be behind — and the setup interview wants it before there is one.
                Button("Heart rate from Health") { showingHeartRate = true }
                    .font(.footnote)
                    .padding(.top, 4)

                Text(AppServer.host)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(28)
        .task { await session.loadProviders() }
        .sheet(isPresented: $showingHeartRate) { HeartRateView() }
    }

    /// Apple's own button, because Apple asks for it by name — and because the sheet it
    /// raises is the point: no browser, and Face ID on an account this phone already has.
    private var appleButton: some View {
        SignInWithAppleButton(.continue, onRequest: AppleSignIn.configure) { result in
            Task { await session.completeAppleSignIn(result) }
        }
        .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
        .frame(height: 48)
        .disabled(session.busy)
    }

    /// One provider, or the plain button that leaves the choice to the page. `pressed` keeps
    /// the wait on the button that was tapped rather than on all three.
    @ViewBuilder private func button(labelled label: String, for provider: String?) -> some View {
        Button {
            pressed = provider
            Task { await session.signIn(with: provider) }
        } label: {
            Text(session.busy && pressed == provider ? "Signing in…" : label)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .disabled(session.busy)
    }
}
