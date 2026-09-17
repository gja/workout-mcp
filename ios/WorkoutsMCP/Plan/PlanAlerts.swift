// A planned target as a watch alert.
//
// An end the plan left open is filled rather than dropped. WorkoutKit does have one-sided
// alerts, but they carry no side: `SpeedThresholdAlert` and its power and cadence siblings
// hold a single `target` and nothing to say whether that number is the floor or the
// ceiling, and Apple does not document which the watch reads it as — `slower than 7:45/km`
// and `faster than 7:45/km` would go out as the same alert. A range alert says which way
// round it is, so the open end gets a stand-in from `Open` below, chosen past anything a
// session records so the athlete is never held to it.
//
// A bound written as a percentage — 85% of max HR, 95% of FTP — is the one thing still
// dropped, and for a different reason: there the number itself is missing rather than the
// end, and converting it needs the athlete's own profile, which this app does not hold. A
// target that gets no alert is not lost — `WorkoutKitSync` writes it into the step's name,
// which the watch shows.

import Foundation
import WorkoutKit

enum PlanAlerts {
    /// What an open end becomes. Each one is past what a session reaches — nobody jogs a
    /// recovery slower than an hour a kilometre, or holds a minute a kilometre — so a band
    /// the plan left open on one side reads on the watch as the one bound it actually named.
    private enum Open {
        /// 60:00/km and 1:00/km, as metres a second, the unit the plan arrives in.
        static let slowest = 1000.0 / 3600
        static let fastest = 1000.0 / 60
        static let lowestHeartRate = 30.0
        static let highestHeartRate = 240.0
        static let lowestPower = 0.0
        static let highestPower = 2000.0
        static let lowestCadence = 0.0
        static let highestCadence = 250.0
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

    /// Foundation's `UnitFrequency` is hertz all the way down and has no beats-a-minute, so a
    /// rate the plan wrote per minute is converted on the way in. `Measurement` compares by
    /// dimension rather than by number, so the watch gets the band that was written.
    private static func perMinute(_ rate: Double) -> Measurement<UnitFrequency> {
        Measurement(value: rate / 60, unit: .hertz)
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
