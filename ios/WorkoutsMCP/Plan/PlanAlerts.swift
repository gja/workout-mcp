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
    static func alert(for target: PlanTarget, sport: FitSport) -> (any WorkoutAlert)? {
        switch target {
        case .open:
            return nil

        case .zone(let metric, let zone):
            switch metric {
            case "heart_rate": return HeartRateZoneAlert(zone: zone)
            case "power": return PowerZoneAlert(zone: zone)
            // A pace zone is the athlete's own table, which WorkoutKit has no alert for.
            default: return nil
            }

        case .heartRate(let low, let high):
            guard let low, let high, low.isAbsolute, high.isAbsolute else { return nil }
            return HeartRateRangeAlert(target: Int(low.value) ... Int(high.value))

        case .power(let low, let high):
            guard let low, let high, low.isAbsolute, high.isAbsolute else { return nil }
            return PowerRangeAlert(
                target: Measurement(value: low.value, unit: UnitPower.watts)
                    ... Measurement(value: high.value, unit: UnitPower.watts)
            )

        case .speed(let low, let high):
            guard let low, let high, low > 0, high > 0 else { return nil }
            return SpeedRangeAlert(
                target: Measurement(value: min(low, high), unit: UnitSpeed.metersPerSecond)
                    ... Measurement(value: max(low, high), unit: UnitSpeed.metersPerSecond)
            )

        case .cadence(let low, let high):
            guard let low, let high else { return nil }
            return CadenceRangeAlert(target: Int(low) ... Int(high))
        }
    }
}
