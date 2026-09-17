// What the home screen shows and does: the plan on one side, what Health recorded on the
// other, and the two buttons that join them up.

import Foundation
import HealthKit

@MainActor
final class HomeModel: ObservableObject {
    @Published private(set) var workouts: [PlannedWorkout] = []
    @Published private(set) var activities: [HKWorkout] = []
    @Published private(set) var scheduled: Set<String> = []
    @Published var loading = false
    @Published var note: String?
    @Published var problem: String?

    /// What the server keeps: a week back and a fortnight ahead. Asking wider is narrowed anyway.
    private let daysBack = 7
    private let daysAhead = 14

    /// When a scheduled workout lands on the watch. Early enough to be there before a dawn run.
    private let scheduledHour = 5

    func refresh(using client: WorkoutsClient?) async {
        guard let client else { return }
        loading = true
        defer { loading = false }

        do {
            let from = Calendar.current.date(byAdding: .day, value: -daysBack, to: Date()) ?? Date()
            let to = Calendar.current.date(byAdding: .day, value: daysAhead, to: Date()) ?? Date()
            workouts = try await client.workouts(from: from, to: to).sorted { $0.date < $1.date }
            problem = nil
        } catch {
            problem = error.localizedDescription
        }

        await refreshHealth()
        scheduled = await WorkoutKitSync.scheduledKeys()
    }

    func refreshHealth() async {
        do {
            try await HealthAccess.request()
            activities = try await HealthAccess.recentActivities(days: daysBack + 1)
        } catch {
            problem = error.localizedDescription
        }
    }

    // --- Out to Apple ---------------------------------------------------------------------

    func sendToFitness(_ workout: PlannedWorkout, using client: WorkoutsClient?) async {
        guard let client else { return }
        loading = true
        defer { loading = false }

        do {
            await WorkoutKitSync.authorize()
            let plan = try await client.plan(for: workout)
            try await WorkoutKitSync.schedule(plan, at: scheduledTime(for: workout))
            scheduled = await WorkoutKitSync.scheduledKeys()
            note = "\(workout.name) is in Apple Fitness."
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Everything still to come that is not already on the watch.
    func sendEverythingToFitness(using client: WorkoutsClient?) async {
        let today = WorkoutDate.string(Date())
        for workout in workouts where workout.date >= today && !workout.isDone && !scheduled.contains(workout.key) {
            await sendToFitness(workout, using: client)
            if problem != nil { return }
        }
        note = "Apple Fitness is up to date."
    }

    func removeFromFitness(_ workout: PlannedWorkout) async {
        await WorkoutKitSync.unschedule(key: workout.key)
        scheduled = await WorkoutKitSync.scheduledKeys()
    }

    private func scheduledTime(for workout: PlannedWorkout) -> Date {
        let day = workout.day ?? Date()
        return Calendar.current.date(bySettingHour: scheduledHour, minute: 0, second: 0, of: day) ?? day
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
        let bytes = ActivityFit.encode(recorded)

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

    private func filename(for activity: HKWorkout) -> String {
        let stamp = DateFormatter()
        stamp.locale = Locale(identifier: "en_US_POSIX")
        stamp.dateFormat = "yyyy-MM-dd-HHmm"
        let sport = HealthAccess.sport(of: activity) == .cycling ? "ride" : "run"
        return "\(stamp.string(from: activity.startDate))-\(sport).fit"
    }
}
