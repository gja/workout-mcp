// A planned target as a watch alert.
//
// An end the plan left open is filled rather than dropped. WorkoutKit's one-sided alerts
// hold a single `target` and no side, and Apple does not document which the watch reads it
// as, so `slower than 7:45/km` and `faster than 7:45/km` would go out identically. A range
// alert says which way round it is, so the open end gets a stand-in from `Open` below.
//
// A percentage bound is the one thing still dropped, for a different reason: there the
// number itself is missing, and converting it needs a profile this app does not hold. A
// target with no alert is not lost — `WorkoutKitSync` writes it into the step's name.

import Foundation
import WorkoutKit

enum PlanAlerts {
    /// What an open end becomes: past anything a session reaches and no further, because a
    /// figure outside what the watch has a dial for is worse than a wide band. None is zero,
    /// which reads as no target rather than no floor.
    private enum Open {
        /// 20:00/km and 2:00/km, as metres a second, the unit the plan arrives in — slower
        /// than a walk, and faster than the mile record.
        static let slowest = 1000.0 / 1200
        static let fastest = 1000.0 / 120
        static let lowestHeartRate = 40.0
        static let highestHeartRate = 220.0
        static let lowestPower = 10.0
        static let highestPower = 1000.0
        static let lowestCadence = 20.0
        static let highestCadence = 200.0
    }

    static func alert(for target: PlanTarget) -> (any WorkoutAlert)? {
        switch target {
        case .open:
            return nil

        case .zone(let metric, let zone):
            // The plan allows seven zones and the watch has five. Clamping would put the
            // athlete in zone 5 for a zone 7 rep and say nothing; no alert says no alert.
            guard (1 ... 5).contains(zone) else { return nil }
            switch metric {
            case "heart_rate": return HeartRateZoneAlert(zone: zone)
            case "power": return PowerZoneAlert(zone: zone)
            // A pace zone is the athlete's own table, which WorkoutKit has no alert for.
            default: return nil
            }

        case .heartRate(let low, let high):
            guard let ends = bounds(low, high, Open.lowestHeartRate, Open.highestHeartRate) else { return nil }
            return HeartRateRangeAlert(target: band(ends.low, ends.high, perMinute))

        case .power(let low, let high):
            guard let ends = bounds(low, high, Open.lowestPower, Open.highestPower) else { return nil }
            return PowerRangeAlert(target: band(ends.low, ends.high) {
                Measurement(value: $0, unit: UnitPower.watts)
            })

        case .speed(let low, let high, _):
            // A pace that came through as zero or less is not an open end but a broken one.
            if let low, low <= 0 { return nil }
            if let high, high <= 0 { return nil }
            guard let ends = bounds(low, high, Open.slowest, Open.fastest) else { return nil }
            return SpeedRangeAlert(
                target: band(ends.low, ends.high) { Measurement(value: $0, unit: UnitSpeed.metersPerSecond) },
                // The band is a pace to hold now, not an average to finish the step on.
                metric: .current
            )

        case .cadence(let low, let high):
            guard let ends = bounds(low, high, Open.lowestCadence, Open.highestCadence) else { return nil }
            return CadenceRangeAlert(target: band(ends.low, ends.high, perMinute))
        }
    }

    /// The two ends to alert on, with `floor` or `ceiling` standing in for one the plan left
    /// open. Nil for a target with no bound at all, which is `.open` by another name.
    private static func bounds(
        _ low: Double?,
        _ high: Double?,
        _ floor: Double,
        _ ceiling: Double
    ) -> (low: Double, high: Double)? {
        guard low != nil || high != nil else { return nil }
        return (low ?? floor, high ?? ceiling)
    }

    /// The same, for the two metrics whose bounds can arrive as a percentage. A stand-in
    /// cannot rescue those: it is the number that is missing, not the end.
    private static func bounds(
        _ low: PlanBound?,
        _ high: PlanBound?,
        _ floor: Double,
        _ ceiling: Double
    ) -> (low: Double, high: Double)? {
        guard low?.isAbsolute != false, high?.isAbsolute != false else { return nil }
        return bounds(low?.value, high?.value, floor, ceiling)
    }

    /// What WorkoutKit actually reads off a heart rate or cadence alert: the number, as beats
    /// or rotations a minute. `UnitFrequency` is hertz and its multiples and has no case for
    /// it, so this is the one written out rather than `.hertz`, which the number is not.
    ///
    /// The coefficient is 1 rather than 1/60 deliberately. It is not a conversion to hertz,
    /// it is a statement that the number is already the one the API takes — so a `converted`
    /// anywhere below cannot put back the 60 that sent 145 bpm out as 2.4 and left every step
    /// of a long run reading **0 BPM** in Apple Fitness.
    private static let perMinuteUnit = UnitFrequency(
        symbol: "/min",
        converter: UnitConverterLinear(coefficient: 1)
    )

    private static func perMinute(_ rate: Double) -> Measurement<UnitFrequency> {
        Measurement(value: rate, unit: perMinuteUnit)
    }

    /// Lowest end first, whatever order the two arrived in: `a ... b` traps when `a > b`, and
    /// a band written backwards is a crash rather than a rejected workout.
    private static func band<Scale: Dimension>(
        _ first: Double,
        _ second: Double,
        _ measure: (Double) -> Measurement<Scale>
    ) -> ClosedRange<Measurement<Scale>> {
        measure(min(first, second)) ... measure(max(first, second))
    }
}
