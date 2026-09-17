// What the app knows and does: the plan, what the watch recorded, and the two directions
// they travel in — out to Apple Fitness, and back to the server as a file.
//
// One instance, held by `RootView` and shared by all three tabs, because Planned and
// Executed are two readings of the same load rather than two screens with their own.

import FITSwiftSDK
import Foundation
import HealthKit

/// Where the plan stands with Apple Fitness. The Settings tab exists to say this line, so
/// it distinguishes "not yet" from "failed" rather than showing both as an absence.
enum SyncPhase: Equatable {
    case never
    case syncing(done: Int, of: Int)
    case synced(at: Date, count: Int)
    case failed(String)
}

/// A session the athlete did, as the Executed tab lists it: what this phone recorded, what
/// the server holds against a planned workout, or — usually — both ends of the same session.
struct ExecutedSession: Identifiable, Hashable {
    /// What Health recorded. Absent for a session the server knows about and this phone does
    /// not: one recorded on another device, or ingested from a connected platform.
    let activity: HKWorkout?
    /// The planned workout it was, where one is known.
    let workout: PlannedWorkout?

    var id: String { activity?.uuid.uuidString ?? workout?.key ?? "none" }

    /// When it happened, for the one ordering the tab has.
    var when: Date { activity?.startDate ?? workout?.doneAt ?? workout?.day ?? .distantPast }

    var sport: String {
        if let activity { return HealthAccess.isRide(activity) ? "Ride" : "Run" }
        return workout?.sport.capitalized ?? "Session"
    }

    /// Whether the server has read a file for this session, so its numbers are there to show.
    var isRecorded: Bool { workout?.stats?.session != nil }

    static func == (lhs: ExecutedSession, rhs: ExecutedSession) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var workouts: [PlannedWorkout] = []
    /// Whether `workouts` is the plan or just the last thing that loaded. A failed listing
    /// looks exactly like an empty one, and the two mean opposite things to a prune.
    private var planIsKnown = false
    @Published private(set) var activities: [HKWorkout] = []
    @Published private(set) var sync: SyncPhase = .never
    @Published var loading = false
    @Published var note: String?
    @Published var problem: String?

    /// What the server keeps, and what the app shows: a week back, a fortnight ahead.
    private let recentDays = 7
    private let plannedDays = 14

    /// How much of that goes to the watch.
    ///
    /// Two days back as well as forward, because a day missed is a session still worth doing
    /// and it should not need the app to get it back. Seven ahead rather than the fourteen
    /// the server holds, because the far end of a fortnight is a plan that has not settled
    /// yet, and a watch full of it is a list to scroll past.
    private let scheduleFrom = -2
    private let scheduleTo = 7

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

    // --- What the tabs show ------------------------------------------------------------

    /// Today onwards, in the order they will be run.
    var upcoming: [PlannedWorkout] {
        let today = WorkoutDate.string(Date())
        return workouts.filter { !$0.isDone && $0.date >= today }
    }

    /// Behind, and not done. Listed rather than hidden: these are the ones still on the
    /// watch, because a sync reaches two days back for exactly this reason.
    var missed: [PlannedWorkout] {
        let today = WorkoutDate.string(Date())
        return workouts.filter { !$0.isDone && $0.date < today }.sorted { $0.date > $1.date }
    }

    /// Every session there is evidence of, newest first: what Health has, plus anything the
    /// server has marked done that this phone never recorded.
    var executed: [ExecutedSession] {
        let recorded = activities.map { ExecutedSession(activity: $0, workout: suggestion(for: $0)) }
        let matched = Set(recorded.compactMap { $0.workout?.key })
        let elsewhere = workouts
            .filter { $0.isDone && !matched.contains($0.key) }
            .map { ExecutedSession(activity: nil, workout: $0) }

        return (recorded + elsewhere).sorted { $0.when > $1.when }
    }

    /// The same workout as the listing has it. A detail view holds the one it was opened
    /// with, and an upload a moment ago made that copy stale.
    func current(_ workout: PlannedWorkout) -> PlannedWorkout {
        workouts.first { $0.key == workout.key } ?? workout
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

    /// The near part of the plan, onto the watch. Run whole rather than per workout, because
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
        let due = workouts.filter { $0.date >= day(scheduleFrom) && $0.date <= day(scheduleTo) && !$0.isDone }

        sync = .syncing(done: 0, of: due.count)
        await WorkoutKitSync.authorize()

        var placed = 0
        for (slot, workout) in due.enumerated() {
            do {
                let plan = try await client.plan(for: workout)
                try await WorkoutKitSync.schedule(plan, at: scheduledTime(for: workout, slot: slot))
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

    private func day(_ offset: Int) -> String {
        WorkoutDate.string(Calendar.current.date(byAdding: .day, value: offset, to: Date()) ?? Date())
    }

    /// Early on the day it is planned for, and never in the past — which is where this
    /// morning is by the time anybody opens the app, and where the scheduler has nothing to
    /// show for it. A day already gone is scheduled for the next whole hour instead, which is
    /// what makes a session missed on Sunday reachable on Tuesday.
    ///
    /// The next *whole* hour rather than a minute from now, so a resync ten minutes later
    /// lands on the same time and the watch is not rewritten for nothing. And a minute apart
    /// per workout, so two missed days are two entries rather than one time carrying both.
    private func scheduledTime(for workout: PlannedWorkout, slot: Int) -> Date {
        let calendar = Calendar.current
        let planned = workout.day ?? Date()
        let early = calendar.date(bySettingHour: scheduledHour, minute: 0, second: 0, of: planned) ?? planned

        var hour = calendar.dateComponents([.year, .month, .day, .hour], from: Date())
        hour.hour = (hour.hour ?? 0) + 1
        let soon = calendar.date(from: hour) ?? Date()

        return max(early, soon).addingTimeInterval(Double(60 * slot))
    }

    // --- Back from Apple -------------------------------------------------------------------

    /// Which planned workout a recorded session was, as far as this app can tell: the plan id
    /// the watch carried, and failing that the one workout of that sport planned for that day.
    ///
    /// It is not a question the athlete is asked. A session the watch named is certain, a
    /// day with one workout of that sport on it is as good as certain, and anything else is
    /// a guess this app would be putting in front of them as a choice — with the plan, the
    /// dashboard and the assistant all better placed to settle it than a picker here.
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
                said += " — \(Formats.distance(metres))"
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
