// The plan, handed to Apple's own scheduler so it reaches the Workout app and the watch.
//
// Everything this app knows about WorkoutKit is in this file and `PlanAlerts.swift`. If a
// future SDK renames an initialiser, these two are the only places that have to move.

import Foundation
import HealthKit
import WorkoutKit

enum PlanSyncError: LocalizedError {
    case notAuthorized
    case nothingToSchedule(String)

    var errorDescription: String? {
        switch self {
        case .notAuthorized:
            return "Scheduling workouts has not been allowed. Turn it on in Settings › Fitness."
        case .nothingToSchedule(let name):
            return "\(name) has no steps that can be sent to Apple Fitness."
        }
    }
}

enum WorkoutKitSync {
    /// Asked once; the answer is remembered by the system, not here.
    @discardableResult
    static func authorize() async -> WorkoutScheduler.AuthorizationState {
        await WorkoutScheduler.shared.requestAuthorization()
    }

    static func isAuthorized() async -> Bool {
        await WorkoutScheduler.shared.authorizationState == .authorized
    }

    /// Puts one planned workout on the athlete's watch, at `time` on the day it is planned for.
    static func schedule(_ plan: ResolvedPlan, at time: Date) async throws {
        guard await isAuthorized() else { throw PlanSyncError.notAuthorized }

        let custom = try build(plan)
        let key = "\(plan.date)/\(plan.id)"
        let planID = PlanLink.planID(for: key)
        let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: time)

        // Replaced rather than added to: the id is derived from the key, so an edit upstream
        // that is re-sent lands on the same plan instead of leaving the old one on the watch.
        await remove(planID: planID)
        try await WorkoutScheduler.shared.schedule(WorkoutPlan(.custom(custom), id: planID), at: when)
        PlanLink.remember(planID: planID, for: key)
    }

    /// The keys of everything this app has put on the watch and that is still there.
    static func scheduledKeys() async -> Set<String> {
        var keys: Set<String> = []
        for scheduled in await WorkoutScheduler.shared.scheduledWorkouts {
            if let key = PlanLink.workoutKey(forPlan: scheduled.plan.id) { keys.insert(key) }
        }
        return keys
    }

    static func unschedule(key: String) async {
        await remove(planID: PlanLink.planID(for: key))
    }

    private static func remove(planID: UUID) async {
        for scheduled in await WorkoutScheduler.shared.scheduledWorkouts where scheduled.plan.id == planID {
            await WorkoutScheduler.shared.remove(scheduled.plan, at: scheduled.date)
        }
    }

    // --- The plan, in Apple's shape ----------------------------------------------------

    /// A warmup step and a cooldown step are Apple's own slots; everything between them is a
    /// block. A repeat becomes a block that iterates, which is the one place the two models
    /// line up exactly.
    static func build(_ plan: ResolvedPlan) throws -> CustomWorkout {
        let sport = Sports.fit(plan.sport)
        var steps = plan.steps

        var warmup: WorkoutStep?
        if let first = steps.first, case .effort(let effort) = first, effort.intensity == "warmup" {
            warmup = step(effort, sport: sport)
            steps.removeFirst()
        }

        var cooldown: WorkoutStep?
        if let last = steps.last, case .effort(let effort) = last, effort.intensity == "cooldown" {
            cooldown = step(effort, sport: sport)
            steps.removeLast()
        }

        let blocks = steps.map { block($0, sport: sport) }
        guard warmup != nil || cooldown != nil || !blocks.isEmpty else {
            throw PlanSyncError.nothingToSchedule(plan.name)
        }

        return CustomWorkout(
            activity: Sports.activityType(plan.sport),
            location: Sports.location(plan.subSport),
            displayName: plan.name,
            warmup: warmup,
            blocks: blocks,
            cooldown: cooldown
        )
    }

    private static func block(_ resolved: ResolvedStep, sport: FitSport) -> IntervalBlock {
        switch resolved {
        case .effort(let effort):
            return IntervalBlock(steps: [interval(effort, sport: sport)], iterations: 1)
        case .block(let times, let steps):
            // A repeat of repeats is flattened: WorkoutKit blocks do not nest, and the plan
            // format allows two levels. The reps are right; only the grouping is lost.
            return IntervalBlock(steps: steps.flatMap { efforts(of: $0) }.map { interval($0, sport: sport) },
                                 iterations: times)
        }
    }

    private static func efforts(of resolved: ResolvedStep) -> [PlanEffort] {
        switch resolved {
        case .effort(let effort): return [effort]
        case .block(let times, let steps): return (0 ..< times).flatMap { _ in steps.flatMap(efforts) }
        }
    }

    private static func interval(_ effort: PlanEffort, sport: FitSport) -> IntervalStep {
        IntervalStep(effort.isRecovery ? .recovery : .work, step: step(effort, sport: sport))
    }

    private static func step(_ effort: PlanEffort, sport: FitSport) -> WorkoutStep {
        var step = WorkoutStep(goal: goal(effort.duration), alert: PlanAlerts.alert(for: effort.target, sport: sport))
        step.displayName = effort.name
        return step
    }

    private static func goal(_ duration: PlanDuration) -> WorkoutGoal {
        switch duration {
        case .open: return .open
        case .time(let seconds): return .time(seconds, .seconds)
        case .distance(let meters): return .distance(meters, .meters)
        }
    }
}

/// The one place a workout-mcp sport name becomes an Apple one, or a FIT one.
enum Sports {
    static func fit(_ sport: String) -> FitSport {
        switch sport {
        case "running": return .running
        case "cycling": return .cycling
        case "swimming": return .swimming
        case "walking": return .walking
        case "hiking": return .hiking
        case "rowing": return .rowing
        case "training": return .training
        default: return .generic
        }
    }

    static func activityType(_ sport: String) -> HKWorkoutActivityType {
        switch sport {
        case "running": return .running
        case "cycling": return .cycling
        case "swimming": return .swimming
        case "walking": return .walking
        case "hiking": return .hiking
        case "rowing": return .rowing
        case "training": return .functionalStrengthTraining
        default: return .other
        }
    }

    /// Indoors is what the sub-sport says, and outdoors is the assumption otherwise.
    static func location(_ subSport: String?) -> HKWorkoutSessionLocationType {
        let indoors: Set<String> = [
            "treadmill", "indoor_cycling", "spin", "virtual_activity", "indoor_rowing", "indoor_walking",
        ]
        return indoors.contains(subSport ?? "") ? .indoor : .outdoor
    }

    static func fitSubSport(_ subSport: String?) -> FitSubSport {
        switch subSport {
        case "treadmill": return .treadmill
        case "street": return .street
        case "trail": return .trail
        case "track": return .track
        case "spin": return .spin
        case "indoor_cycling": return .indoorCycling
        case "road": return .road
        case "mountain": return .mountain
        case "indoor_rowing": return .indoorRowing
        case "indoor_walking": return .indoorWalking
        case "virtual_activity": return .virtualActivity
        default: return .generic
        }
    }
}
