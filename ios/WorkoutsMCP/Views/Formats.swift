// Turning the numbers into something worth reading. The Swift half of src/client/format.ts,
// and deliberately the same words: a lap reads the same on the phone as on the dashboard.

import Foundation
import HealthKit

enum Formats {
    // --- Time and distance --------------------------------------------------------------

    /// "9:58", or "1:04:30" once it runs past the hour. Lap and session lengths.
    static func clock(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded())
        return whole >= 3600
            ? String(format: "%d:%02d:%02d", whole / 3600, (whole % 3600) / 60, whole % 60)
            : String(format: "%d:%02d", whole / 60, whole % 60)
    }

    /// "45 min", "1 h 15". How long a plan is, where the seconds are noise.
    static func minutes(_ seconds: Double) -> String {
        let whole = Int((seconds / 60).rounded())
        if whole < 60 { return "\(whole) min" }
        let remainder = whole % 60
        return remainder == 0 ? "\(whole / 60) h" : "\(whole / 60) h \(remainder)"
    }

    static func distance(_ metres: Double) -> String {
        metres >= 1000
            ? String(format: "%.2f km", metres / 1000)
            : String(format: "%.0f m", metres)
    }

    /// Seconds per kilometre as a pace an athlete reads: `4:05/km`.
    static func pace(_ secondsPerKm: Double) -> String { "\(clock(secondsPerKm))/km" }

    /// "Fri, 12 Sep, 06:30".
    static func moment(_ date: Date) -> String {
        date.formatted(date: .abbreviated, time: .shortened)
    }

    /// "Fri, 19 Sep" — the day a workout sits on, without the time it does not have.
    static func day(_ date: Date) -> String {
        date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated))
    }

    /// Coarse on purpose. A sync five seconds ago and one twenty seconds ago are the same
    /// fact, and a line that counts seconds at the athlete invites them to read it twice to
    /// see whether it changed. Minutes until an hour, then hours, then days.
    static func since(_ then: Date, now: Date = Date()) -> String {
        let seconds = max(0, now.timeIntervalSince(then))

        switch seconds {
        case ..<60: return "just now"
        case ..<120: return "a minute ago"
        case ..<3600: return "\(Int(seconds / 60)) minutes ago"
        case ..<7200: return "an hour ago"
        case ..<86_400: return "\(Int(seconds / 3600)) hours ago"
        case ..<172_800: return "yesterday"
        default: return "\(Int(seconds / 86_400)) days ago"
        }
    }

    static func percent(_ fraction: Double) -> String { "\(Int((fraction * 100).rounded()))%" }

    // --- What Health recorded -----------------------------------------------------------

    static func describe(_ activity: HKWorkout) -> String {
        var parts = [moment(activity.startDate)]
        parts.append(clock(activity.duration))
        if let metres = HealthAccess.distance(of: activity), metres > 0 {
            parts.append(distance(metres))
        }
        return parts.joined(separator: " · ")
    }

    // --- What was planned ---------------------------------------------------------------

    /// "1 h 15 · 12 km". A trailing "+" means open steps, so the totals are a floor.
    static func summary(of totals: PlannedTotals?) -> String {
        guard let totals else { return "" }

        var parts: [String] = []
        if totals.seconds > 0 { parts.append(minutes(totals.seconds)) }
        if totals.meters > 0 { parts.append(distance(totals.meters)) }

        if parts.isEmpty { return totals.openSteps > 0 ? "open ended" : "" }
        return parts.joined(separator: " · ") + (totals.openSteps > 0 ? "+" : "")
    }

    static func describe(_ duration: PlanDuration) -> String {
        switch duration {
        case .open: return "until lap press"
        case .time(let seconds): return minutes(seconds)
        case .distance(let meters): return distance(meters)
        }
    }

    /// The step's band as the plan wrote it, or nil where it has none to show. A percentage
    /// bound is carried through as a percentage: converting it needs the athlete's own
    /// profile, which this app does not hold.
    static func describe(_ target: PlanTarget) -> String? {
        switch target {
        case .open:
            return nil
        case .zone(let metric, let zone):
            return "\(metric.replacingOccurrences(of: "_", with: " ")) zone \(zone)"
        case .heartRate(let low, let high):
            return range(bound(low, absolute: "bpm", relative: "% max HR"),
                         bound(high, absolute: "bpm", relative: "% max HR"))
        case .power(let low, let high):
            return range(bound(low, absolute: "W", relative: "% FTP"),
                         bound(high, absolute: "W", relative: "% FTP"))
        case .cadence(let low, let high):
            guard let both = range(low.map(whole), high.map(whole)) else { return nil }
            return "\(both) rpm"
        case .speed(let low, let high, let unit):
            // A faster pace is a higher speed, so the ends swap back for display.
            let metres = unit == "mi" ? 1609.344 : 1000.0
            let fastest = high.map { clock(metres / $0) }
            let slowest = low.map { clock(metres / $0) }
            if let fastest, let slowest { return "\(fastest)-\(slowest)/\(unit)" }
            if let slowest { return "faster than \(slowest)/\(unit)" }
            return fastest.map { "slower than \($0)/\(unit)" }
        }
    }

    private static func bound(_ value: PlanBound?, absolute: String, relative: String) -> String? {
        guard let value else { return nil }
        return value.isAbsolute ? "\(whole(value.value)) \(absolute)" : "\(whole(value.value))\(relative)"
    }

    /// "140-150 bpm", "above 140 bpm", "below 150 bpm" — the unit said once, on the end.
    private static func range(_ low: String?, _ high: String?) -> String? {
        if let low, let high { return "\(low)-\(high)" }
        if let low { return "above \(low)" }
        return high.map { "below \($0)" }
    }

    // --- What was recorded --------------------------------------------------------------

    /// The unit a metric is written in, so a band and its actual read the same way.
    static func metric(_ metric: String, _ value: Double) -> String {
        switch metric {
        case "pace_s_km": return pace(value)
        case "hr": return "\(whole(value)) bpm"
        case "power_w": return "\(whole(value)) W"
        case "cadence": return "\(whole(value)) spm"
        default: return "\(whole(value))"
        }
    }

    /// "4:00-4:15/km", with the unit said once.
    static func band(_ target: LapTarget) -> String {
        target.metric == "pace_s_km"
            ? "\(clock(target.low))-\(pace(target.high))"
            : "\(whole(target.low))-\(metric(target.metric, target.high))"
    }

    /// What a lap actually did on the metric it was aimed at.
    static func actual(_ lap: LapLine, on name: String) -> String? {
        let recorded: [String: Double?] = [
            "pace_s_km": lap.avgPaceSKm,
            "hr": lap.avgHr,
            "power_w": lap.avgPowerW,
            "cadence": lap.avgCadence,
        ]
        guard let value = recorded[name] ?? nil else { return nil }
        return metric(name, value)
    }

    /// The headline figure for a lap that was given no target: whatever the session actually
    /// measured, in the order a reader would look for it.
    static func headline(_ lap: LapLine) -> String? {
        if let value = lap.avgPaceSKm { return pace(value) }
        if let power = lap.avgPowerW { return "\(whole(power)) W" }
        return lap.avgHr.map { "\(whole($0)) bpm" }
    }

    /// How long a lap ran, by whatever it was measured in.
    static func length(_ lap: LapLine) -> String {
        [lap.distanceM.map(distance), lap.durationS.map(clock)]
            .compactMap { $0 }
            .joined(separator: " · ")
    }

    /// "52 min · 10.2 km · 4:05/km · 148 bpm avg" — the session in one line.
    static func line(_ session: SessionTotals) -> String {
        [
            session.movingS.map(minutes),
            session.distanceM.map(distance),
            session.avgPaceSKm.map(pace),
            session.avgPowerW.map { "\(whole($0)) W" },
            session.avgHr.map { "\(whole($0)) bpm avg" },
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }

    /// A flag as a sentence, for the few worth putting in front of an athlete. A flag with
    /// no sentence here is one that says nothing they can act on.
    static func note(for flag: String) -> String? {
        switch flag {
        case "no_hr": return "No heart rate was recorded."
        case "hr_dropout": return "The heart rate reading dropped out."
        case "gps_dropout": return "GPS dropped out, so pace is unreliable."
        case "long_pause": return "The recording was paused for a while."
        case "autopause_active": return "Auto-pause was on, so moving time is under elapsed."
        case "laps_do_not_match_plan":
            return "The laps do not line up with the plan, so nothing is matched to a step."
        case "short_lap": return "Under a minute, so it is not split into quarters."
        case "extra_lap": return "Past the end of the plan, so it is matched to no step."
        case "source_unreadable": return "The recording could not be read."
        default: return nil
        }
    }

    static func notes(_ flags: [String]) -> [String] { flags.compactMap(note(for:)) }

    /// A figure the server rounded to an integer, printed as one. Everything but pace and
    /// grade comes back whole, and "148.0 bpm" reads like a precision nobody claimed.
    static func whole(_ value: Double) -> String { String(Int(value.rounded())) }
}
