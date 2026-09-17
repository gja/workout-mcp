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
    /// Asked for if it has not been given, and then insisted on. Once a sync rather than
    /// once a workout: every call into the scheduler crosses to a system service, and the
    /// answer cannot change in the middle of one. The asking itself is remembered by the
    /// system and not here, so a second sync does not ask again.
    static func requireAuthorization() async throws {
        guard await WorkoutScheduler.shared.requestAuthorization() == .authorized else {
            throw PlanSyncError.notAuthorized
        }
    }

    /// What the scheduler is holding, read once. Nothing outside this file is given
    /// WorkoutKit's own type for it, so a caller can carry the reading around and still not
    /// know what a scheduled workout is; `ids` is all one needs to ask whether a plan it
    /// placed is still there.
    struct Schedule {
        fileprivate let workouts: [ScheduledWorkoutPlan]
        let ids: Set<UUID>
    }

    /// Read once a sync and handed to everything below. Asked per workout, this was the same
    /// question to the same system service as many times as there were workouts, and a sync
    /// that changes nothing should ask it once.
    static func scheduled() async -> Schedule {
        let workouts = await WorkoutScheduler.shared.scheduledWorkouts
        return Schedule(workouts: workouts, ids: Set(workouts.map(\.plan.id)))
    }

    /// Puts one planned workout on the athlete's watch, at `time` on the day it is planned for.
    static func schedule(_ plan: ResolvedPlan, at time: Date, replacing existing: Schedule) async throws {
        let custom = try build(plan)
        let key = "\(plan.date)/\(plan.id)"
        let planID = PlanLink.planID(for: key)
        let when = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: time)

        // Replaced rather than added to: the id is derived from the key, so an edit upstream
        // that is re-sent lands on the same plan instead of leaving the old one on the watch.
        for scheduled in existing.workouts where scheduled.plan.id == planID {
            await WorkoutScheduler.shared.remove(scheduled.plan, at: scheduled.date)
        }
        await WorkoutScheduler.shared.schedule(WorkoutPlan(.custom(custom), id: planID), at: when)
        PlanLink.remember(planID: planID, for: key)
    }

    /// Takes off the watch anything this app put there that the plan no longer has — a
    /// workout deleted or moved upstream, which would otherwise sit there being wrong.
    /// Only plans this app scheduled are touched; anything else the athlete follows is not ours.
    static func pruneTo(keys: Set<String>, among existing: Schedule) async {
        for scheduled in existing.workouts {
            guard let key = PlanLink.workoutKey(forPlan: scheduled.plan.id), !keys.contains(key) else { continue }
            await WorkoutScheduler.shared.remove(scheduled.plan, at: scheduled.date)
        }
    }

    // --- The plan, in Apple's shape ----------------------------------------------------

    /// A warmup step and a cooldown step are Apple's own slots; everything between them is a
    /// block. A repeat becomes a block that iterates, which is the one place the two models
    /// line up exactly.
    static func build(_ plan: ResolvedPlan) throws -> CustomWorkout {
        var steps = plan.steps

        var warmup: WorkoutStep?
        if let first = steps.first, case .effort(let effort) = first, effort.intensity == "warmup" {
            warmup = step(effort)
            steps.removeFirst()
        }

        var cooldown: WorkoutStep?
        if let last = steps.last, case .effort(let effort) = last, effort.intensity == "cooldown" {
            cooldown = step(effort)
            steps.removeLast()
        }

        let blocks = steps.map { block($0) }
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

    private static func block(_ resolved: ResolvedStep) -> IntervalBlock {
        switch resolved {
        case .effort(let effort):
            return IntervalBlock(steps: [interval(effort)], iterations: 1)
        case .block(let times, let steps):
            // A repeat of repeats is flattened: WorkoutKit blocks do not nest, and the plan
            // format allows two levels. The reps are right; only the grouping is lost.
            return IntervalBlock(steps: steps.flatMap { efforts(of: $0) }.map { interval($0) }, iterations: times)
        }
    }

    private static func efforts(of resolved: ResolvedStep) -> [PlanEffort] {
        switch resolved {
        case .effort(let effort): return [effort]
        case .block(let times, let steps): return (0 ..< times).flatMap { _ in steps.flatMap(efforts) }
        }
    }

    private static func interval(_ effort: PlanEffort) -> IntervalStep {
        IntervalStep(effort.isRecovery ? .recovery : .work, step: step(effort))
    }

    private static func step(_ effort: PlanEffort) -> WorkoutStep {
        let alert = PlanAlerts.alert(for: effort.target)
        var step = WorkoutStep(goal: goal(effort.duration), alert: alert)
        step.displayName = name(effort, alerted: alert != nil)
        return step
    }

    /// A step carries one alert and one line of text, and a plan step can hold more target
    /// than that: a bound `PlanAlerts` will not invent an end for, and a second target,
    /// which WorkoutKit has nowhere to put. Whatever did not become an alert is written
    /// into the name the watch already shows — `Easy @ slower than 7:45/km` — in the same
    /// words the workout reads in on the phone. Nothing is alerted on that the plan did not
    /// ask for; the athlete simply gets to see what the step was for.
    private static func name(_ effort: PlanEffort, alerted: Bool) -> String? {
        var unalerted: [PlanTarget] = alerted ? [] : [effort.target]
        if let secondary = effort.secondaryTarget { unalerted.append(secondary) }

        let described = unalerted.compactMap { Formats.describe($0) }
        guard !described.isEmpty else { return effort.name }

        let targets = described.joined(separator: " + ")
        guard let name = effort.name else { return targets }
        return "\(name) @ \(targets)"
    }

    private static func goal(_ duration: PlanDuration) -> WorkoutGoal {
        switch duration {
        case .open: return .open
        case .time(let seconds): return .time(seconds, .seconds)
        case .distance(let meters): return .distance(meters, .meters)
        }
    }
}
