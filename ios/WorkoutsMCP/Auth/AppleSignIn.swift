// Sign in with Apple without a browser: Apple's own sheet hands the app an authorization
// code, and `POST /api/apple-session` trades it for the `wk_` token every REST call takes.
//
// The code is spent on the server because spending it needs the team's .p8 key, which is a
// Wrangler secret and never reaches the phone. What comes back is the same credential the
// browser flow ends with, listed under *API tokens* and revoked there. See docs/auth.md.

import AuthenticationServices
import Foundation

enum AppleSignIn {
    /// Named as the browser flow names it, so one athlete's two sign-ins are one line each.
    private static let appName = "WorkoutsMCP for iOS"

    /// The address, as the browser flow asks for it. Not the name: nothing here stores one.
    static func configure(_ request: ASAuthorizationAppleIDRequest) {
        request.requestedScopes = [.email]
    }

    /// Single use and good for minutes, so it is spent the moment the sheet closes.
    static func session(from authorization: ASAuthorization, to server: URL) async throws -> StoredSession {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let code = credential.authorizationCode,
              let spendable = String(data: code, encoding: .utf8) else {
            throw AuthError.refused("Apple returned a sign-in this app cannot read")
        }

        guard let url = URL(string: "/api/apple-session", relativeTo: server) else {
            throw AuthError.noMetadata(server.absoluteString)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["code": spendable, "name": appName])

        let (data, response) = try await URLSession.shared.data(for: request)
        let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard (200 ..< 300).contains((response as? HTTPURLResponse)?.statusCode ?? 0),
              let token = body?["token"] as? String else {
            throw AuthError.refused(body?["error"] as? String ?? "the deployment refused the Apple sign-in")
        }
        return StoredSession(server: server, token: token)
    }
}
