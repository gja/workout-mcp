// What the home screen shows and does: where the plan stands with Apple Fitness, what the
// watch recorded in the last week, and the two buttons that join them up.

import FITSwiftSDK
import Foundation
import HealthKit

/// Where the plan stands with Apple Fitness. The whole point of the home screen is that
/// this line is true, so it distinguishes "not yet" from "failed" rather than showing both
/// as an absence.
enum SyncPhase: Equatable {
    case never
    case syncing(done: Int, of: Int)
    case synced(at: Date, count: Int)
    case failed(String)
}

@MainActor
final class HomeModel: ObservableObject {
    @Published private(set) var workouts: [PlannedWorkout] = []
    /// Whether `workouts` is the plan or just the last thing that loaded. A failed listing
    /// looks exactly like an empty one, and the two mean opposite things to a prune.
    private var planIsKnown = false
    @Published private(set) var activities: [HKWorkout] = []
    @Published private(set) var sync: SyncPhase = .never
    @Published var loading = false
    @Published var note: String?
    @Published var problem: String?

    /// What the server keeps, and what the home screen shows: a week back, a fortnight ahead.
    private let recentDays = 7
    private let plannedDays = 14

    /// When a scheduled workout lands on the watch. Early enough to be there before a dawn run.
    private let scheduledHour = 5

    /// How stale a sync has to be before opening the app does one on its own.
    private let resyncAfter: TimeInterval = 30 * 60

    private let syncedAtKey = "last-synced-at"
    private let syncedCountKey = "last-synced-count"

    init() {
        let defaults = UserDefaults.standard
        if let at = defaults.object(forKey: syncedAtKey) as? Date {
            sync = .synced(at: at, count: defaults.integer(forKey: syncedCountKey))
        }
    }

    // --- Loading ---------------------------------------------------------------------------

    func refresh(using client: WorkoutsClient?) async {
        guard let client else { return }
        loading = true
        defer { loading = false }

        do {
            let from = Calendar.current.date(byAdding: .day, value: -recentDays, to: Date()) ?? Date()
            let to = Calendar.current.date(byAdding: .day, value: plannedDays, to: Date()) ?? Date()
            workouts = try await client.workouts(from: from, to: to).sorted { $0.date < $1.date }
            planIsKnown = true
            problem = nil
        } catch {
            problem = error.localizedDescription
        }

        do {
            try await HealthAccess.request()
            activities = try await HealthAccess.recentActivities(days: recentDays)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Opening the app syncs, unless it already did recently: the status line claims the plan
    /// is on the watch, so it has to have put it there.
    func refreshAndSyncIfStale(using client: WorkoutsClient?) async {
        await refresh(using: client)

        switch sync {
        case .synced(let at, _) where Date().timeIntervalSince(at) < resyncAfter: return
        case .syncing: return
        default: await syncToAppleFitness(using: client)
        }
    }

    // --- Out to Apple -------------------------------------------------------------------------

    /// Everything still to come, onto the watch. Run whole rather than per workout, because
    /// what the athlete wants to know is whether their plan is there, not which parts of it.
    func syncToAppleFitness(using client: WorkoutsClient?) async {
        guard let client else { return }
        // A tap while it is already running is not a second run.
        if case .syncing = sync { return }
        await performSync(using: client)
    }

    private func performSync(using client: WorkoutsClient) async {
        guard planIsKnown else {
            sync = .failed("could not read your plan")
            return
        }
        let today = WorkoutDate.string(Date())
        let due = workouts.filter { $0.date >= today && !$0.isDone }

        sync = .syncing(done: 0, of: due.count)
        await WorkoutKitSync.authorize()

        var placed = 0
        for workout in due {
            do {
                let plan = try await client.plan(for: workout)
                try await WorkoutKitSync.schedule(plan, at: scheduledTime(for: workout))
                placed += 1
                sync = .syncing(done: placed, of: due.count)
            } catch {
                sync = .failed(error.localizedDescription)
                return
            }
        }

        // Anything the plan no longer has is taken off the watch, so the two really do agree.
        await WorkoutKitSync.pruneTo(keys: Set(due.map(\.key)))

        let at = Date()
        UserDefaults.standard.set(at, forKey: syncedAtKey)
        UserDefaults.standard.set(placed, forKey: syncedCountKey)
        sync = .synced(at: at, count: placed)
    }

    /// Early on the day it is planned for — but never in the past, which is where the small
    /// hours of this morning are by the time anybody opens the app, and where the scheduler
    /// would have nothing to show for it.
    private func scheduledTime(for workout: PlannedWorkout) -> Date {
        let day = workout.day ?? Date()
        let early = Calendar.current.date(bySettingHour: scheduledHour, minute: 0, second: 0, of: day) ?? day
        return max(early, Date().addingTimeInterval(60))
    }

    // --- Back from Apple -------------------------------------------------------------------

    /// Which planned workout a recorded session was, as far as this app can tell: the plan id
    /// the watch carried, and failing that the one workout of that sport planned for that day.
    func suggestion(for activity: HKWorkout) -> PlannedWorkout? {
        if let id = HealthAccess.planID(of: activity), let key = PlanLink.workoutKey(forPlan: id) {
            return workouts.first { $0.key == key }
        }
        let day = WorkoutDate.string(activity.startDate)
        let sport = HealthAccess.sport(of: activity)
        let sameDay = workouts.filter { $0.date == day && Sports.fit($0.sport) == sport }
        return sameDay.count == 1 ? sameDay.first : nil
    }

    /// The FIT file, written to a temporary file so it can be shared as well as uploaded.
    func buildFit(for activity: HKWorkout, matching workout: PlannedWorkout?) async throws -> URL {
        let recorded = try await SessionReader.read(activity, as: workout?.key)
        let bytes = try ActivityFit.encode(recorded)

        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename(for: activity))
        try bytes.write(to: url, options: .atomic)
        return url
    }

    /// The other button: the same bytes, posted. The server reads them, stores the numbers and
    /// marks the session done — it keeps no file. See docs/stats.md.
    func upload(_ fit: URL, from activity: HKWorkout, to workout: PlannedWorkout, using client: WorkoutsClient?) async {
        guard let client else { return }
        loading = true
        defer { loading = false }

        do {
            let receipt = try await client.upload(
                try Data(contentsOf: fit),
                to: workout,
                activityID: activity.uuid.uuidString
            )
            var said = "\(workout.name) is done"
            if let metres = receipt.stats?.session?.distanceM, metres > 0 {
                said += String(format: " — %.2f km", metres / 1000)
            }
            note = said
            await refresh(using: client)
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Whether this session has already been read by the server, so a second upload is a
    /// re-upload rather than the first one.
    func isUploaded(_ activity: HKWorkout) -> Bool {
        guard let workout = suggestion(for: activity) else { return false }
        return workout.isDone
    }

    private func filename(for activity: HKWorkout) -> String {
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.dateFormat = "yyyy-MM-dd-HHmm"
        let sport = HealthAccess.isRide(activity) ? "ride" : "run"
        return "\(stamp.string(from: activity.startDate))-\(sport).fit"
    }
}
