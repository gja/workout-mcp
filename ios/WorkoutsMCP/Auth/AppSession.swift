// Who is signed in, and the client that speaks for them. One instance, held by the app.

import Foundation

/// The deployment this build talks to. A constant rather than a setting: asking an athlete
/// for a hostname before they can sign in is a question almost none of them can answer, and
/// the one who can is building this from source and can change a line. Self-hosting is in
/// ios/README.md.
enum AppServer {
    static let host = "workouts-mcp.com"
    static let url = URL(string: "https://\(host)")!
}

@MainActor
final class AppSession: ObservableObject {
    @Published private(set) var stored: StoredSession?
    @Published private(set) var account: Account?
    /// The sign-ins this deployment offers, in its own order. Empty until asked, and empty
    /// where it cannot say — which is the sign-in screen's one plain button.
    @Published private(set) var providers: [String] = []
    @Published var busy = false
    @Published var problem: String?

    private let oauth = OAuth()

    init() {
        stored = StoredSession.load()
    }

    var isSignedIn: Bool { stored != nil }

    var client: WorkoutsClient? { stored?.client }

    /// What the sign-in screen offers a button for. Asked again on each appearance until it
    /// answers, because nothing else will ask.
    func loadProviders() async {
        guard providers.isEmpty else { return }
        providers = await OAuth.providers(of: AppServer.url)
    }

    /// The browser round trip, ending in an app token. `provider` is whichever button was
    /// pressed, carried through so the browser opens on that sign-in. See `OAuth.signIn`.
    func signIn(with provider: String? = nil) async {
        busy = true
        defer { busy = false }

        do {
            try await keep(oauth.signIn(to: AppServer.url, with: provider))
        } catch AuthError.cancelled {
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Who the stored credential belongs to, for the line in Settings. A relaunch loads the
    /// token without asking, so this is the one thing that has to be fetched; a failure is
    /// not worth saying, because the tabs behind it will say it louder.
    func loadAccount() async {
        guard account == nil, let client else { return }
        account = try? await client.me()
    }

    func signOut() {
        StoredSession.forget()
        stored = nil
        account = nil
        problem = nil
    }

    // --- Storing it ------------------------------------------------------------------

    /// Kept only once it has been proved: a credential that cannot read `/api/me` is not a sign-in.
    private func keep(_ session: StoredSession) async throws {
        account = try await session.client.me()
        stored = session
        problem = nil
        session.save()
    }
}
