// The plan in words rather than in the shorthand the screen uses.
//
// A speech synthesiser reads "4:05/km" as a time of day and "800 m" as a letter, so the
// figures a voice says are built separately from the ones it shows. Deliberately not in
// `Formats`, which is the Swift half of `src/client/format.ts` and has to keep saying what
// the dashboard says; nothing here is written down anywhere.

// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import Foundation

enum Spoken {
    /// "4 minutes 5", "45 seconds", "4 minutes".
    static func clock(_ seconds: Double) -> String {
        let whole = Int(seconds.rounded())
        let minutes = whole / 60
        let rest = whole % 60
        if minutes == 0 { return "\(rest) seconds" }
        return rest == 0 ? "\(minutes) minutes" : "\(minutes) minutes \(rest)"
    }

    static func duration(_ duration: PlanDuration) -> String {
        switch duration {
        case .open: return "until you tap next"
        case .time(let seconds): return clock(seconds)
        case .distance(let metres): return distance(metres)
        }
    }

    static func distance(_ metres: Double) -> String {
        guard metres >= 1000 else { return "\(Formats.whole(metres)) metres" }
        let km = metres / 1000
        let rounded = (km * 10).rounded() / 10
        if rounded == rounded.rounded() {
            return rounded == 1 ? "1 kilometre" : "\(Int(rounded)) kilometres"
        }
        return "\(String(format: "%.1f", rounded)) kilometres"
    }

    /// The band, said once. A zone and a percentage are said as written — they are announced
    /// but never policed, because resolving either needs the athlete's profile, which lives
    /// on the server and not in this app. See `TargetWatch`.
    static func target(_ target: PlanTarget) -> String? {
        switch target {
        case .open:
            return nil
        case .zone(let metric, let zone):
            return "\(metric.replacingOccurrences(of: "_", with: " ")) zone \(zone)"
        case .heartRate(let low, let high):
            return bounds(low, high, absolute: "beats per minute", relative: "percent of maximum heart rate")
        case .power(let low, let high):
            return bounds(low, high, absolute: "watts", relative: "percent of F T P")
        case .cadence(let low, let high):
            if let low, let high { return "cadence \(Formats.whole(low)) to \(Formats.whole(high))" }
            if let low { return "cadence above \(Formats.whole(low))" }
            return high.map { "cadence below \(Formats.whole($0))" }
        case .speed(let low, let high, let unit):
            // Named, because "4 minutes to 5 minutes per kilometre" does not otherwise say
            // what it is a figure for. The other bands are named by their own units.
            // A faster pace is a higher speed, so the ends swap back to be said.
            let per = unit == "mi" ? "per mile" : "per kilometre"
            let metres = unit == "mi" ? 1609.344 : 1000.0
            let fastest = high.map { clock(metres / $0) }
            let slowest = low.map { clock(metres / $0) }
            if let fastest, let slowest { return "pace \(fastest) to \(slowest) \(per)" }
            if let slowest { return "pace faster than \(slowest) \(per)" }
            return fastest.map { "pace slower than \($0) \(per)" }
        }
    }

    /// The unit said once where both ends share it, which is almost always, and twice where a
    /// plan has mixed an absolute bound with a relative one.
    private static func bounds(
        _ low: PlanBound?, _ high: PlanBound?, absolute: String, relative: String
    ) -> String? {
        let unit = { (bound: PlanBound) in bound.isAbsolute ? absolute : relative }

        if let low, let high {
            return unit(low) == unit(high)
                ? "\(Formats.whole(low.value)) to \(Formats.whole(high.value)) \(unit(low))"
                : "\(Formats.whole(low.value)) \(unit(low)) to \(Formats.whole(high.value)) \(unit(high))"
        }
        if let low { return "above \(Formats.whole(low.value)) \(unit(low))" }
        return high.map { "below \(Formats.whole($0.value)) \(unit($0))" }
    }
}

#endif
