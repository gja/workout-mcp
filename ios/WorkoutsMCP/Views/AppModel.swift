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
        if let activity { return HealthAccess.label(of: activity) }
        return workout?.sport.capitalized ?? "Session"
    }

    /// Whether the server has read a file for this session, so its numbers are there to show.
    var isRecorded: Bool { workout?.stats?.session != nil }

    static func == (lhs: ExecutedSession, rhs: ExecutedSession) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// One heading on the Planned tab and the workouts under it. A group with nothing in it is
/// never built, so a title here is always a promise that there is something to show.
struct PlannedWeek: Identifiable {
    let title: String
    let workouts: [PlannedWorkout]

    var id: String { title }
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

    /// The plan id each recorded session carries, resolved once at load: `workoutPlan` is
    /// `get async throws` and `suggestion(for:)` is read from a view body, where there is
    /// nothing to await in. A session whose plan cannot be produced is simply absent.
    private var planIDs: [UUID: UUID] = [:]

    /// What the server keeps, and what the app shows: a week back, a fortnight ahead.
    private let recentDays = 7
    private let plannedDays = 14

    /// Bumped each time a background transfer lands, so a screen that is open reads the plan
    /// again. A recording is sent by a `URLSession` that finishes on its own schedule, long
    /// after whichever call handed it over returned.
    @Published private(set) var landed = 0

    init() {
        // Whatever last reached the watch, including a turn iOS granted `PlanRefresh` in the
        // night: the status line is about the watch, not about this run of the app.
        if let last = PlanSync.lastSynced { sync = .synced(at: last.at, count: last.count) }

        NotificationCenter.default.addObserver(
            forName: .sessionUploaded, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.landed += 1 }
        }
    }

    // --- What the tabs show ------------------------------------------------------------

    /// Today onwards, in the order they will be run.
    var upcoming: [PlannedWorkout] {
        let today = WorkoutDate.string(Date())
        return workouts.filter { !$0.isDone && $0.date >= today }
    }

    /// The same workouts under the headings the Planned tab reads them in.
    ///
    /// A week runs **Monday to Sunday** whatever the phone's locale says, because it is a
    /// training week: the long run is on a Sunday, and a Sunday filed under *Next week* on a
    /// Saturday evening is the very next session shown as the one after that. It is also the
    /// week `src/client/dates.ts` groups the dashboard by. An empty group is left out.
    var plannedWeeks: [PlannedWeek] {
        var calendar = Calendar.current
        calendar.firstWeekday = 2 // Monday, whatever the locale's own answer would be.
        let now = Date()
        let weekStart = calendar.dateInterval(of: .weekOfYear, for: now)?.start ?? now
        let boundary = { (weeks: Int) -> String in
            WorkoutDate.string(calendar.date(byAdding: .weekOfYear, value: weeks, to: weekStart) ?? now)
        }
        let nextWeek = boundary(1)
        let after = boundary(2)

        let groups: [(String, [PlannedWorkout])] = [
            ("This week", upcoming.filter { $0.date < nextWeek }),
            ("Next week", upcoming.filter { $0.date >= nextWeek && $0.date < after }),
            ("Later", upcoming.filter { $0.date >= after }),
        ]
        return groups.filter { !$0.1.isEmpty }.map { PlannedWeek(title: $0.0, workouts: $0.1) }
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

    /// Asked for together: each is a round trip to the store, and a week of them one after
    /// another is a week of round trips before the tab can draw.
    private static func planIDs(of activities: [HKWorkout]) async -> [UUID: UUID] {
        await withTaskGroup(of: (UUID, UUID?).self) { group in
            for activity in activities {
                group.addTask { (activity.uuid, await HealthAccess.planID(of: activity)) }
            }

            var found: [UUID: UUID] = [:]
            for await (session, plan) in group {
                if let plan { found[session] = plan }
            }
            return found
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
            // Background delivery needs authorization, which `BackgroundSync.start()` in the
            // app's initialiser cannot have had on a first launch. Enabling it here is what
            // makes HealthKit wake the app for a session recorded today.
            BackgroundSync.enableDelivery()
            // Here for the same reason: a background launch is the wrong moment to ask
            // anybody for anything, and this is the one path with somebody looking.
            await Notify.ask()

            // Resolved before `activities` is published, or every session draws once as
            // unplanned and again a moment later with its workout.
            let recorded = try await HealthAccess.recentActivities(days: recentDays)
            planIDs = await Self.planIDs(of: recorded)
            activities = recorded
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Opening the app syncs unless the watch already holds this plan: the status line
    /// claims it is there, so it has to have put it there. `PlanSync` answers both halves —
    /// four hours since the last sync, or a plan that is not the one that was placed.
    func refreshAndSyncIfStale(using client: WorkoutsClient?) async {
        await refresh(using: client)

        // Whatever the background never got to: `.immediate` delivery is a request rather
        // than a promise, and opening the app is the moment that is certain to happen. On
        // exactly a wake's terms — only sessions the watch named, only ones the server has
        // no recording for.
        //
        // Not refreshed after: the file goes to a background `URLSession` and is still in
        // flight when this returns. `sessionUploaded` says when there is something new to
        // read, and reaches this screen whether a wake or this call sent it.
        await BackgroundSync.uploadWhatIsCertain()

        if case .syncing = sync { return }
        guard PlanSync.isStale || PlanSync.hasChanged(PlanSync.due(in: workouts)) else { return }
        await syncToAppleFitness(using: client)
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

    /// The rules are `PlanSync`'s, because a turn iOS grants in the background runs the same
    /// ones. What is left here is the counting-out the status line does.
    private func performSync(using client: WorkoutsClient) async {
        guard planIsKnown else {
            sync = .failed("could not read your plan")
            return
        }
        let due = PlanSync.due(in: workouts)
        sync = .syncing(done: 0, of: due.count)

        do {
            let placed = try await PlanSync.place(due, using: client) { done in
                Task { @MainActor in
                    if case .syncing = self.sync { self.sync = .syncing(done: done, of: due.count) }
                }
            }
            sync = .synced(at: PlanSync.lastSynced?.at ?? Date(), count: placed)
        } catch {
            sync = .failed(error.localizedDescription)
        }
    }

    // --- Back from Apple -------------------------------------------------------------------

    /// The workout this app wrote into the session when it recorded it, then the plan id the
    /// watch carried, and failing both the one workout of that sport planned for that day.
    /// Never a question the athlete is asked: anything past those three is a guess the plan,
    /// the dashboard and the assistant are all better placed to settle.
    func suggestion(for activity: HKWorkout) -> PlannedWorkout? {
        // First because it is the only one of the three that cannot be wrong: this app was
        // handed the workout, started the session for it and wrote the key down there and
        // then. See `WorkoutRunner`.
        if let key = HealthAccess.recordedKey(of: activity), let mine = workouts.first(where: { $0.key == key }) {
            return mine
        }
        if let id = planIDs[activity.uuid], let key = PlanLink.workoutKey(forPlan: id) {
            return workouts.first { $0.key == key }
        }
        let day = WorkoutDate.string(activity.startDate)
        let sport = HealthAccess.sport(of: activity)
        let sameDay = workouts.filter { $0.date == day && Sports.fit($0.sport) == sport }
        return sameDay.count == 1 ? sameDay.first : nil
    }

    /// The FIT file, written out so it can be shared as well as uploaded. Encoding runs off
    /// the main actor: `ActivityFit.encode` is synchronous work — a setter per field per
    /// second of the recording — and would hold the only thread that draws.
    func buildFit(for activity: HKWorkout, matching workout: PlannedWorkout?) async throws -> URL {
        let recorded = try await SessionReader.read(activity, as: workout?.key)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(filename(for: activity, as: workout))

        try await Task.detached(priority: .userInitiated) {
            try ActivityFit.encode(recorded).write(to: url, options: .atomic)
        }.value

        return url
    }

    /// The other button: the same bytes, posted. The server reads them, stores the numbers and
    /// marks the session done — it keeps no file. See docs/stats.md.
    func upload(_ fit: URL, from activity: HKWorkout, to workout: PlannedWorkout, using client: WorkoutsClient?) async {
        guard let client else { return }
        loading = true
        defer { loading = false }

        do {
            // Off the main actor for the same reason the file was written there: reading a
            // recording back is blocking I/O, and this model is the one that draws.
            let bytes = try await Task.detached(priority: .userInitiated) { try Data(contentsOf: fit) }.value
            let receipt = try await client.upload(
                bytes,
                to: workout.key,
                activityID: activity.uuid.uuidString
            )
            // So a wake does not send it a second time.
            Settled.settle(activity.uuid)
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

    /// `yyyy-mm-dd-<id>-<name>.fit`, the same name `src/recordings/` gives the session in an
    /// archive or a connected drive, so one session is one file by three routes. The id is
    /// the planned workout's, not HealthKit's, which means nothing anywhere else; a session
    /// with no workout to name is `unmatched`.
    private func filename(for activity: HKWorkout, as workout: PlannedWorkout?) -> String {
        let day = WorkoutDate.string(activity.startDate)
        let name = workout?.name ?? HealthAccess.label(of: activity)
        return "\(day)-\(slug(workout?.id ?? "unmatched", 40))-\(slug(name, 80)).fit"
    }

    /// `safe()` in `src/recordings/index.ts`, in Swift, because the two have to agree rather
    /// than nearly agree: separators and control characters become spaces, a run of
    /// whitespace becomes one dash, and letters, digits, dot, dash and underscore survive.
    private func slug(_ value: String, _ limit: Int) -> String {
        let allowed = CharacterSet.letters.union(.decimalDigits).union(CharacterSet(charactersIn: "._-"))
        let separated = String(value.unicodeScalars.map { scalar -> Character in
            let separator = scalar == "/" || scalar == "\\" || CharacterSet.controlCharacters.contains(scalar)
            return separator ? Character(" ") : Character(scalar)
        })

        var out = ""
        for character in separated.split(whereSeparator: \.isWhitespace).joined(separator: "-") {
            guard character.unicodeScalars.allSatisfy(allowed.contains) else { continue }
            if character == "-" && out.hasSuffix("-") { continue }
            out.append(character)
        }

        let name = String(out.trimmingCharacters(in: CharacterSet(charactersIn: "-.")).prefix(limit))
        return name.isEmpty ? "workout" : name
    }
}
