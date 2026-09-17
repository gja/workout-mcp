// Every call this app makes to a workout-mcp deployment. See docs/api.md.

import Foundation

struct ApiError: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }

    /// The credential is gone or was revoked, which is the one failure worth signing out for.
    var isUnauthorized: Bool { status == 401 }
}

struct WorkoutsClient {
    let server: URL
    /// Handed a fresh access token per call, because the stored one may have just been refreshed.
    let token: () async throws -> String

    func me() async throws -> Account {
        try await get("/api/me")
    }

    /// The plan over a range, which the server narrows to its own retention window anyway.
    func workouts(from: Date, to: Date) async throws -> [PlannedWorkout] {
        let listing: WorkoutListing = try await get(
            "/api/workouts.json?from=\(WorkoutDate.string(from))&to=\(WorkoutDate.string(to))"
        )
        return listing.workouts
    }

    func plan(for workout: PlannedWorkout) async throws -> ResolvedPlan {
        try await get("/api/workouts/\(workout.key)/plan")
    }

    /// The recorded session in full: the totals a listing already carries, and the laps it
    /// does not. Its own read for the reason docs/stats.md gives — a week of workouts is
    /// mostly laps, and a listing pays for them to throw them away.
    func stats(for workout: PlannedWorkout) async throws -> WorkoutStats {
        try await get("/api/workouts/\(workout.key)/stats")
    }

    /// The FIT file as the body. Comes back with the workout marked done. See docs/stats.md.
    @discardableResult
    func upload(_ fit: Data, to workout: PlannedWorkout, activityID: String) async throws -> RecordingReceipt {
        let escaped = activityID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "upload"
        var request = try await signed("/api/workouts/\(workout.key)/recording?activity_id=\(escaped)")
        request.httpMethod = "POST"
        request.setValue("application/vnd.ant.fit", forHTTPHeaderField: "Content-Type")
        request.httpBody = fit
        return try await send(request)
    }

    // --- The plumbing ------------------------------------------------------------

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try await send(try await signed(path))
    }

    private func signed(_ path: String) async throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: server) else {
            throw ApiError(status: 0, message: "\(server.absoluteString) and \(path) do not make a URL")
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0

        guard (200 ..< 300).contains(status) else {
            // The server names the field it refused, which is more use than the status code.
            let said = (try? JSONDecoder().decode(ServerError.self, from: data))?.error
            throw ApiError(status: status, message: said ?? "the server answered \(status)")
        }

        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw ApiError(status: status, message: "could not read the answer: \(error.localizedDescription)")
        }
    }
}

/// `/api/me`: who the credential belongs to, and the days the server will answer for.
struct Account: Decodable {
    let id: String
    let email: String?
    let window: RetentionWindow

    struct RetentionWindow: Decodable {
        let from: String
        let to: String
    }
}

private struct WorkoutListing: Decodable {
    let workouts: [PlannedWorkout]
}

private struct ServerError: Decodable {
    let error: String
}
