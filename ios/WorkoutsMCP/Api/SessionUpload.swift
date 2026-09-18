// Handing the file to iOS rather than posting it here. See "And with the app shut" in
// docs/ios.md.
//
// A wake gets about thirty seconds, and one upload was taking seventeen to thirty-four of
// them — read the session out of Health, encode the FIT, post it. Three wakes in a row hit
// `ran out of time` on the same 90-second walk before a fourth got through, which is a coin
// toss rather than a sync. A background `URLSession` moves the part that does not fit out of
// this process: the wake writes a file and hands it over, and iOS finishes the transfer in
// its own time, after this process is suspended or gone.
//
// Which means the answer arrives somewhere else. `didCompleteWithError` below is what settles
// a session, and it may well run in a later launch than the one that sent it.

import Foundation
import UIKit

final class SessionUpload: NSObject {
    static let shared = SessionUpload()

    /// The same identifier every launch, because that is what iOS hands the outstanding
    /// transfers back to. Recreating the session under it is the whole of re-attaching.
    private static let identifier = "ag.myca.workoutsmcp.upload"

    /// Touched on every launch, including a background one: until the session exists, iOS has
    /// nowhere to deliver what it finished while the app was gone.
    static func start() { _ = shared.session }

    /// Handed over by the app delegate when iOS launches the app only to say a transfer
    /// finished, and called back once everything outstanding has been reported.
    var whenDone: (() -> Void)?

    /// What the server said, kept per task so a refusal can name the reason. Only ever touched
    /// on the session's own delegate queue, which is serial.
    fileprivate var answers: [Int: Data] = [:]

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifier)
        // Not discretionary: somebody just finished a session and is waiting to see it.
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    /// Started here, finished by iOS. Returns once the transfer is the system's problem.
    func hand(_ fit: Data, to key: String, activity: UUID, using client: WorkoutsClient) async throws {
        let request = try await client.uploadRequest(to: key, activityID: activity.uuidString)
        let file = try staged(fit, for: activity)

        let task = session.uploadTask(with: request, fromFile: file)
        // All that survives into the delegate, which may be running in a later process than
        // this one: everything else would have to be looked up again from `UserDefaults`.
        task.taskDescription = "\(activity.uuidString) \(key)"
        task.resume()
    }

    /// A file, because a background session will not take a body in memory. Named for the
    /// session so a retry overwrites rather than accumulates.
    private func staged(_ fit: Data, for activity: UUID) throws -> URL {
        let directory = URL.temporaryDirectory.appending(path: "session-uploads", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appending(path: "\(activity.uuidString).fit")
        try fit.write(to: file, options: .atomic)
        return file
    }
}

extension SessionUpload: URLSessionDataDelegate {
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        answers[dataTask.taskIdentifier, default: Data()].append(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let said = answers.removeValue(forKey: task.taskIdentifier)
        guard let (activity, key) = Self.named(task) else { return }

        Handed.release(activity)
        try? FileManager.default.removeItem(
            at: URL.temporaryDirectory
                .appending(path: "session-uploads", directoryHint: .isDirectory)
                .appending(path: "\(activity.uuidString).fit")
        )

        if let error {
            // Left unsettled on purpose: a transfer iOS gave up on is one the next wake should
            // find again, and nothing here can tell a dropped connection from a refusal.
            SyncLog.record(.upload, "could not upload \(key): \(SyncLog.describe(error))")
            return
        }

        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        guard !(200 ..< 300).contains(status) else {
            Settled.settle(activity)
            SyncLog.uploaded(1)
            SyncLog.record(.upload, "finished uploading \(key)")
            // For a screen that may be open: the transfer finishes on its own schedule, so
            // whoever started it is long past the point of refreshing after it.
            NotificationCenter.default.post(name: .sessionUploaded, object: nil)
            // And for the far more likely case of no screen at all. The workout's name comes
            // back in the answer we are already holding, so this costs no request.
            Notify.uploaded(Self.received(said)?.name)
            return
        }

        let reason = said.flatMap { try? JSONDecoder().decode(ServerError.self, from: $0) }?.error
        let refusal = ApiError(status: status, message: reason ?? "the server answered \(status)")
        SyncLog.record(.upload, "could not upload \(key): \(SyncLog.describe(refusal))")

        // The same rule the foreground path uses: an answer another attempt would get again.
        if (400 ..< 500).contains(status), ![401, 408, 429].contains(status) {
            Settled.settle(activity)
            SyncLog.record(.upload, "not offering \(key) again")
        }
    }

    /// Everything iOS had to report is reported; the launch it made to tell us can end.
    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let done = whenDone
        whenDone = nil
        DispatchQueue.main.async { done?() }
    }

    /// The server's answer to the POST, which is the workout it just marked done.
    private static func received(_ said: Data?) -> RecordingReceipt? {
        guard let said else { return nil }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try? decoder.decode(RecordingReceipt.self, from: said)
    }

    private static func named(_ task: URLSessionTask) -> (activity: UUID, key: String)? {
        let parts = (task.taskDescription ?? "").split(separator: " ")
        guard parts.count == 2, let activity = UUID(uuidString: String(parts[0])) else { return nil }
        return (activity, String(parts[1]))
    }
}

extension Notification.Name {
    /// A recorded session reached the server. Posted whichever path sent it, because the
    /// answer arrives after that path has finished.
    static let sessionUploaded = Notification.Name("ag.myca.workoutsmcp.sessionUploaded")
}
