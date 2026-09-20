// Signing in: RFC 8414 discovery, RFC 7591 registration, an authorization code with PKCE,
// and then one trade of the grant for the `wk_` token the REST API takes.
//
// The deployment is the authorization server as well as the API, so there is one URL to
// ask the athlete for. See docs/mcp.md for the server's half of the OAuth round trip and
// docs/auth.md for why the app ends up holding a `wk_` token rather than the grant.

import AuthenticationServices
import CryptoKit
import Foundation
import UIKit

/// What the app signed in with: the credential the REST API takes, and the address it is for.
struct StoredSession: Codable, Equatable {
    var server: URL
    var token: String
}

extension StoredSession {
    /// Read straight from the keychain rather than from whatever the UI is holding, because
    /// a background launch has no UI: see `Health/BackgroundSync.swift`. The keychain item is
    /// `afterFirstUnlockThisDeviceOnly`, so it is there for a wake and not before a first unlock.
    private static let account = "session"

    static func load() -> StoredSession? {
        guard let data = Keychain.read(account) else { return nil }
        return try? JSONDecoder().decode(StoredSession.self, from: data)
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        Keychain.save(data, as: Self.account)
    }

    static func forget() { Keychain.delete(account) }

    var client: WorkoutsClient {
        // Never expires and is never renewed: it is a `wk_` token, revoked from the dashboard.
        WorkoutsClient(server: server) { token }
    }
}

struct AuthMetadata: Decodable {
    let authorizationEndpoint: URL
    let tokenEndpoint: URL
    let registrationEndpoint: URL?

    private enum CodingKeys: String, CodingKey {
        case authorizationEndpoint = "authorization_endpoint"
        case tokenEndpoint = "token_endpoint"
        case registrationEndpoint = "registration_endpoint"
    }
}

enum AuthError: LocalizedError {
    case noMetadata(String)
    case noRegistration
    case refused(String)
    case cancelled

    var errorDescription: String? {
        switch self {
        case .noMetadata(let host): return "\(host) does not look like a workout-mcp deployment"
        case .noRegistration: return "that deployment does not let an app register itself; paste an API token instead"
        case .refused(let why): return why
        case .cancelled: return "sign-in was cancelled"
        }
    }
}

@MainActor
final class OAuth: NSObject {
    /// ASWebAuthenticationSession claims this itself and hands the callback only to the
    /// session that opened it, so the app registers no URL type for it.
    static let callbackScheme = "workoutsmcp"
    private static let redirectURI = "\(callbackScheme)://oauth"
    /// `app-token` is what lets the grant be traded for the credential the REST API takes,
    /// and it is a scope of its own so the athlete approves it by name. See docs/auth.md.
    private static let scope = "workouts app-token"
    private static let appName = "WorkoutsMCP for iOS"

    private var session: ASWebAuthenticationSession?

    /// Which sign-ins this deployment offers, so the app's own screen can name them, and
    /// which of them need no browser. No credential exists yet, so the route is public;
    /// nothing to say is the one-button screen.
    static func signInOptions(of server: URL) async -> (providers: [String], native: [String]) {
        guard let url = URL(string: "/auth/providers", relativeTo: server) else { return ([], []) }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let named = body["providers"] as? [String] else { return ([], []) }
            return (named, body["native"] as? [String] ?? [])
        } catch {
            // Offline, or a deployment predating the route: neither is worth saying on a
            // screen whose one button still works.
            return ([], [])
        }
    }

    /// Registers this install, opens the consent page, exchanges the code, and trades the
    /// grant for an API token. The grant is not kept: the token is what every call uses.
    ///
    /// `provider` is the sign-in already picked on our own screen: no part of the
    /// authorization request, read by the consent page alone. See docs/auth.md.
    func signIn(to server: URL, with provider: String? = nil) async throws -> StoredSession {
        let metadata = try await Self.metadata(of: server)
        guard let registration = metadata.registrationEndpoint else { throw AuthError.noRegistration }

        let clientID = try await Self.register(at: registration)
        let verifier = Self.randomURLSafe(64)
        let state = Self.randomURLSafe(24)

        guard var authorize = URLComponents(url: metadata.authorizationEndpoint, resolvingAgainstBaseURL: false) else {
            throw AuthError.noMetadata(server.host ?? server.absoluteString)
        }
        authorize.queryItems = (authorize.queryItems ?? []) + [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientID),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "scope", value: Self.scope),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: Self.challenge(for: verifier)),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ] + (provider.map { [URLQueryItem(name: "provider", value: $0)] } ?? [])
        guard let opening = authorize.url else { throw AuthError.refused("the authorization URL would not build") }

        let callback = try await open(opening)
        let returned = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in returned.first { $0.name == name }?.value }

        if let problem = value("error") { throw AuthError.refused(value("error_description") ?? problem) }
        // Checked before the code is spent: a callback we did not start is not ours.
        guard value("state") == state, let code = value("code") else {
            throw AuthError.refused("the sign-in came back without the state it went out with")
        }

        let grant = try await Self.exchange(
            at: metadata.tokenEndpoint,
            form: [
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": Self.redirectURI,
                "client_id": clientID,
                "code_verifier": verifier,
            ]
        )
        return StoredSession(server: server, token: try await Self.appToken(from: server, grant: grant))
    }

    // --- The round trips ---------------------------------------------------------------

    private static func metadata(of server: URL) async throws -> AuthMetadata {
        guard let url = URL(string: "/.well-known/oauth-authorization-server", relativeTo: server) else {
            throw AuthError.noMetadata(server.absoluteString)
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let metadata = try? JSONDecoder().decode(AuthMetadata.self, from: data) else {
            throw AuthError.noMetadata(server.host ?? server.absoluteString)
        }
        return metadata
    }

    /// RFC 7591. Registered fresh each sign-in: the provider hands out a public client with
    /// no secret, so there is nothing worth keeping and nothing to go stale when it is purged.
    private static func register(at endpoint: URL) async throws -> String {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "client_name": appName,
            "redirect_uris": [redirectURI],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
            "scope": scope,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let clientID = body["client_id"] as? String else {
            throw AuthError.refused("the deployment would not register this app")
        }
        return clientID
    }

    private static func exchange(at endpoint: URL, form: [String: String]) async throws -> String {
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" }
            .joined(separator: "&")
            .data(using: .utf8)

        let (data, response) = try await URLSession.shared.data(for: request)
        guard (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = body["access_token"] as? String else {
            let said = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error_description"]
            throw AuthError.refused(said as? String ?? "the deployment refused the sign-in")
        }
        return token
    }

    /// `POST /api/app-token`: the grant, once, for the credential the REST API takes. It is
    /// listed on the dashboard under its name above, and revoking it there signs this app out.
    private static func appToken(from server: URL, grant: String) async throws -> String {
        guard let url = URL(string: "/api/app-token", relativeTo: server) else {
            throw AuthError.noMetadata(server.absoluteString)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(grant)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["name": appName])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0),
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = body["token"] as? String else {
            throw AuthError.refused("signed in, but the deployment would not issue an app token")
        }
        return token
    }

    private func open(_ url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: Self.callbackScheme) { callback, error in
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: AuthError.cancelled)
                } else {
                    continuation.resume(throwing: error ?? AuthError.cancelled)
                }
            }
            // Not ephemeral: the sign-in is Google's or Apple's, and their cookie is the point.
            session.prefersEphemeralWebBrowserSession = false
            session.presentationContextProvider = self
            self.session = session
            session.start()
        }
    }

    // --- PKCE ------------------------------------------------------------------------

    private static func randomURLSafe(_ bytes: Int) -> String {
        var raw = [UInt8](repeating: 0, count: bytes)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes, &raw)
        return base64URL(Data(raw))
    }

    private static func challenge(for verifier: String) -> String {
        base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

extension OAuth: ASWebAuthenticationPresentationContextProviding {
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
