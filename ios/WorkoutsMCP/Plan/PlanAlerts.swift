// A planned target as a watch alert.
//
// Two whole classes of target are deliberately dropped rather than guessed at. A bound
// written as a percentage — 85% of max HR, 95% of FTP — is a number only the athlete's own
// profile holds, and this app does not hold it; inventing one would put a band on the watch
// that nobody chose. And a half-open target (`4:15/km or faster`) has no range to alert on,
// so the step goes out with its duration and no alert rather than with a bound made up for
// its missing end. The step still runs; the watch simply does not beep at it.

import Foundation
import WorkoutKit

enum PlanAlerts {
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
            guard let low, let high, low.isAbsolute, high.isAbsolute else { return nil }
            return HeartRateRangeAlert(target: band(low.value, high.value, perMinute))

        case .power(let low, let high):
            guard let low, let high, low.isAbsolute, high.isAbsolute else { return nil }
            return PowerRangeAlert(target: band(low.value, high.value) {
                Measurement(value: $0, unit: UnitPower.watts)
            })

        case .speed(let low, let high, _):
            guard let low, let high, low > 0, high > 0 else { return nil }
            return SpeedRangeAlert(
                target: band(low, high) { Measurement(value: $0, unit: UnitSpeed.metersPerSecond) },
                // The band is a pace to hold now, not an average to finish the step on.
                metric: .current
            )

        case .cadence(let low, let high):
            guard let low, let high else { return nil }
            return CadenceRangeAlert(target: band(low, high, perMinute))
        }
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
