// Who is signed in, and the client that speaks for them. One instance, held by the app.

import Foundation

@MainActor
final class AppSession: ObservableObject {
    @Published private(set) var stored: StoredSession?
    @Published private(set) var account: Account?
    @Published var busy = false
    @Published var problem: String?

    private let oauth = OAuth()

    init() {
        stored = StoredSession.load()
    }

    var isSignedIn: Bool { stored != nil }

    var client: WorkoutsClient? { stored?.client }

    /// The browser round trip, ending in an app token. See `OAuth.signIn`.
    func signIn(to address: String) async {
        await attempt(address) { server in try await self.oauth.signIn(to: server) }
    }

    /// The other door: a `wk_` token minted on the dashboard and pasted in.
    func signIn(to address: String, withToken token: String) async {
        await attempt(address) { server in
            StoredSession(server: server, token: token.trimmingCharacters(in: .whitespacesAndNewlines))
        }
    }

    func signOut() {
        StoredSession.forget()
        stored = nil
        account = nil
        problem = nil
    }

    // --- Storing it ------------------------------------------------------------------

    private func attempt(_ address: String, _ signIn: (URL) async throws -> StoredSession) async {
        guard let server = Self.serverURL(from: address) else {
            problem = "that is not a web address"
            return
        }
        busy = true
        defer { busy = false }

        do {
            try await keep(signIn(server))
        } catch AuthError.cancelled {
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Kept only once it has been proved: a credential that cannot read `/api/me` is not a sign-in.
    private func keep(_ session: StoredSession) async throws {
        account = try await session.client.me()
        stored = session
        problem = nil
        session.save()
    }

    /// `workouts.example.com`, `https://workouts.example.com/`, either way round.
    private static func serverURL(from address: String) -> URL? {
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://\(text)" }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), url.host != nil else { return nil }
        return url
    }
}
