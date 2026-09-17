// An `HKWorkout` read back out as a second-by-second recording, which is the shape a FIT
// activity file wants and the shape Health does not hand over.
//
// HealthKit stores a workout as a handful of series that agree on nothing: a route of
// irregular locations, heart rates every few seconds, distances as sums over intervals of
// their own. This walks a one-second timeline from the start of the session and fills each
// second from whichever series covers it, leaving a second nothing covers empty — never
// zero, which downstream would read as a measurement.

import CoreLocation
import Foundation
import HealthKit

enum SessionReader {
    /// A recording longer than this is cut: the file would outrun what the server decodes.
    private static let maximumSeconds = 12 * 60 * 60

    static func read(_ workout: HKWorkout, as workoutKey: String?) async throws -> RecordedSession {
        let sport = HealthAccess.sport(of: workout)
        let start = workout.startDate
        let seconds = max(min(Int(workout.endDate.timeIntervalSince(start).rounded()), maximumSeconds), 1)
        let end = start.addingTimeInterval(Double(seconds))

        // Every series first, then one pass over the timeline: nothing is fetched while the
        // samples are being written, so there is one owner of them at a time.
        let route = try await locations(of: workout)
        let heartRates = await quantities(.heartRate, of: workout)
        let powers = await quantities(sport == .cycling ? .cyclingPower : .runningPower, of: workout)
        let speeds = await quantities(sport == .cycling ? .cyclingSpeed : .runningSpeed, of: workout)
        let cadences = await quantities(sport == .cycling ? .cyclingCadence : .stepCount, of: workout)
        let distances = await quantities(sport == .cycling ? .distanceCycling : .distanceWalkingRunning, of: workout)

        var samples = (0 ... seconds).map { RecordedSample(time: start.addingTimeInterval(Double($0))) }
        let timeline = Timeline(start: start, count: samples.count)

        for location in route {
            guard let index = timeline.slot(location.timestamp) else { continue }
            samples[index].latitude = location.coordinate.latitude
            samples[index].longitude = location.coordinate.longitude
            if location.verticalAccuracy >= 0 { samples[index].altitude = location.altitude }
            if location.speed >= 0 { samples[index].speed = location.speed }
        }

        let beatsPerMinute = HKUnit.count().unitDivided(by: .minute())
        spread(heartRates, as: beatsPerMinute, over: timeline, into: &samples) { $0.heartRate = $1 }
        spread(powers, as: .watt(), over: timeline, into: &samples) { $0.power = $1 }
        spread(speeds, as: HKUnit.meter().unitDivided(by: .second()), over: timeline, into: &samples) { $0.speed = $1 }

        if sport == .cycling {
            spread(cadences, as: beatsPerMinute, over: timeline, into: &samples) { $0.cadence = $1 }
        } else {
            // Running records steps, not a cadence, so it is steps over the seconds they took.
            spread(cadences, as: .count(), over: timeline, into: &samples, perSecond: true) { $0.cadence = $1 * 60 }
        }

        accumulate(distances, over: timeline, into: &samples)
        fillSpeedFromDistance(&samples)

        return RecordedSession(
            sport: sport,
            subSport: HealthAccess.subSport(of: workout),
            start: start,
            end: end,
            movingSeconds: min(workout.duration, Double(seconds)),
            samples: samples,
            laps: laps(of: workout, from: start, to: end),
            calories: workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
                .sumQuantity()?.doubleValue(for: .kilocalorie()),
            workoutKey: workoutKey
        )
    }

    // --- The timeline ---------------------------------------------------------------------

    private struct Timeline {
        let start: Date
        let count: Int

        func slot(_ time: Date) -> Int? {
            let index = Int(time.timeIntervalSince(start).rounded())
            return (0 ..< count).contains(index) ? index : nil
        }
    }

    /// Each sample held across the seconds it covers, which is how a watch writes them:
    /// one reading every few seconds, meant for all of them. `perSecond` divides a total
    /// — a count of steps — by the seconds it was counted over first.
    private static func spread(
        _ samples: [HKQuantitySample],
        as unit: HKUnit,
        over timeline: Timeline,
        into filled: inout [RecordedSample],
        perSecond: Bool = false,
        assign: (inout RecordedSample, Double) -> Void
    ) {
        for sample in samples {
            let seconds = sample.endDate.timeIntervalSince(sample.startDate)
            var value = sample.quantity.doubleValue(for: unit)
            if perSecond {
                guard seconds > 0 else { continue }
                value /= seconds
            }
            guard value > 0, let from = timeline.slot(sample.startDate) else { continue }

            let to = timeline.slot(sample.endDate) ?? from
            for index in from ... max(from, to) { assign(&filled[index], value) }
        }
    }

    /// FIT wants the total so far, and Health gives sums over intervals of its own choosing,
    /// so they are added up in order and carried across the seconds no sample covered.
    private static func accumulate(_ samples: [HKQuantitySample], over timeline: Timeline, into filled: inout [RecordedSample]) {
        var total = 0.0
        for sample in samples {
            total += sample.quantity.doubleValue(for: .meter())
            guard let index = timeline.slot(sample.endDate) ?? timeline.slot(sample.startDate) else { continue }
            filled[index].distance = total
        }
        guard total > 0 else { return }

        var carried = 0.0
        for index in filled.indices {
            if let here = filled[index].distance { carried = here } else { filled[index].distance = carried }
        }
    }

    /// A speed the series did not carry, from the distance that did. Pace is the field most
    /// often read off one of these files, and one second of distance is enough to have it.
    private static func fillSpeedFromDistance(_ samples: inout [RecordedSample]) {
        for index in samples.indices where samples[index].speed == nil {
            guard index > 0,
                  let here = samples[index].distance,
                  let before = samples[index - 1].distance else { continue }
            let seconds = samples[index].time.timeIntervalSince(samples[index - 1].time)
            if seconds > 0 { samples[index].speed = max(0, (here - before) / seconds) }
        }
    }

    // --- The segments a lap is made of --------------------------------------------------

    /// One lap per interval the watch marked. A custom workout from the plan records an
    /// activity per step; a plain run records none, and the whole session is one lap.
    private static func laps(of workout: HKWorkout, from start: Date, to end: Date) -> [RecordedLap] {
        let clamp = { (from: Date, to: Date) -> RecordedLap? in
            let opened = max(from, start)
            let closed = min(to, end)
            return closed > opened ? RecordedLap(start: opened, end: closed) : nil
        }

        let activities = workout.workoutActivities.compactMap { activity -> RecordedLap? in
            guard let finished = activity.endDate else { return nil }
            return clamp(activity.startDate, finished)
        }
        if activities.count > 1 { return activities }

        let marks = workout.workoutEvents?
            .filter { $0.type == .segment || $0.type == .lap }
            .compactMap { clamp($0.dateInterval.start, $0.dateInterval.end) } ?? []
        return marks.count > 1 ? marks : []
    }

    // --- Asking Health ----------------------------------------------------------------------

    private static func quantities(_ identifier: HKQuantityTypeIdentifier, of workout: HKWorkout) async -> [HKQuantitySample] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.quantitySample(
                type: HKQuantityType(identifier),
                predicate: HKQuery.predicateForObjects(from: workout)
            )],
            sortDescriptors: [SortDescriptor(\.startDate, order: .forward)]
        )
        // A series the athlete never granted, or a sensor they were not wearing, is empty
        // rather than an error: a run with no power meter is still a run worth uploading.
        return (try? await descriptor.result(for: HealthAccess.store)) ?? []
    }

    private static func locations(of workout: HKWorkout) async throws -> [CLLocation] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.workoutRoute(HKQuery.predicateForObjects(from: workout))],
            sortDescriptors: [SortDescriptor(\.startDate, order: .forward)]
        )
        guard let routes = try? await descriptor.result(for: HealthAccess.store) else { return [] }

        var located: [CLLocation] = []
        for route in routes { located.append(contentsOf: try await points(of: route)) }
        return located.sorted { $0.timestamp < $1.timestamp }
    }

    /// `HKWorkoutRouteQuery` hands the track over in batches and says when it has finished.
    private static func points(of route: HKWorkoutRoute) async throws -> [CLLocation] {
        try await withCheckedThrowingContinuation { continuation in
            var collected: [CLLocation] = []
            var answered = false

            let query = HKWorkoutRouteQuery(route: route) { _, batch, done, error in
                guard !answered else { return }
                if let error {
                    answered = true
                    continuation.resume(throwing: error)
                    return
                }
                collected.append(contentsOf: batch ?? [])
                if done {
                    answered = true
                    continuation.resume(returning: collected)
                }
            }
            HealthAccess.store.execute(query)
        }
    }
}
