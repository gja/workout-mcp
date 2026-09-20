// A button per sign-in the deployment offers, Apple's first: its own sheet over this
// screen, where the others open the browser on that provider rather than on a page asking
// what this one just asked. Everything they want is asked there, and this app never sees a
// password. Why the list is the server's, and what the plain button falls back to, is in
// docs/ios.md.

import AuthenticationServices
import SwiftUI

struct SignInView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.colorScheme) private var colorScheme
    @State private var pressed: String?
    @State private var showingHeartRate = false

    /// One shape for the row, because Apple's button cannot take ours and a row of
    /// buttons that disagree on height and corner reads as three different decisions.
    private static let height: CGFloat = 50
    private static let corner: CGFloat = 12

    /// Ours, not the server's — the dashboard keeps its own in `SignIn.tsx`.
    private static let labels = [
        "google": "Continue with Google",
        "apple": "Continue with Apple",
        "intervals": "Continue with intervals.icu",
    ]

    /// Apple first, the rest in the order the server listed them. It is the sign-in that
    /// costs an athlete on an iPhone the least, and the one Apple asks to be shown first.
    ///
    /// A deployment set up for the app's Apple sign-in but not the browser's lists it only
    /// as native, so the two lists are merged rather than read one off the other.
    private var providers: [String] {
        let all = session.providers + session.nativeProviders.filter { !session.providers.contains($0) }
        return all.filter { $0 == "apple" } + all.filter { $0 != "apple" }
    }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 10) {
                Image(systemName: "figure.run")
                    .font(.system(size: 52))
                    .foregroundStyle(.tint)
                Text("WorkoutsMCP").font(.largeTitle.bold())
                Text("Plan, execute and analyze your workouts with AI")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()

            VStack(spacing: 12) {
                if providers.isEmpty {
                    button(labelled: "Sign in", for: nil)
                } else {
                    ForEach(providers, id: \.self) { provider in
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
        .frame(maxWidth: .infinity)
        .frame(height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
        .disabled(session.busy)
        .opacity(session.busy ? 0.5 : 1)
    }

    /// One provider, or the plain button that leaves the choice to the page. Built rather
    /// than `.borderedProminent`, which sets its own height and corner. `pressed` keeps the
    /// wait on the button that was tapped rather than on all of them.
    private func button(labelled label: String, for provider: String?) -> some View {
        Button {
            pressed = provider
            Task { await session.signIn(with: provider) }
        } label: {
            Text(session.busy && pressed == provider ? "Signing in…" : label)
                .font(.headline)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: Self.height)
                .background(Color.accentColor, in: RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(session.busy)
        .opacity(session.busy ? 0.5 : 1)
    }
}
