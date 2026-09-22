// Whether the athlete is in the band the step asked for, and — the harder half — whether
// that is worth saying out loud.
//
// The judgement is trivial; the restraint is not. A GPS pace crosses a band twice a minute
// on its own, and a voice that announced every crossing would be switched off inside a
// kilometre. So a reading has to stay on one side for `dwell` seconds before it is said, and
// nothing is said twice for the same side.

// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import Foundation

struct TargetWatch {
    enum Side: Equatable { case below, inside, above }

    /// Which of the runner's figures this band is about, so it knows what to hand over.
    enum Metric: Equatable { case speed, heartRate, power, cadence }

    let metric: Metric
    private let low: Double?
    private let high: Double?

    /// The side last said out loud. It starts `inside` rather than unknown, so the first
    /// thing announced is a departure and not a confirmation nobody asked for.
    private var said: Side = .inside
    private var drifting: (side: Side, since: Date)?

    private static let dwell = 10.0

    /// A band this app can police, or nil. A zone and a percentage are neither: both need the
    /// athlete's own profile to resolve, which is the server's — `workout-zones` is the one
    /// source of truth for physiology, for the reason docs/ios.md gives. They are still said
    /// when the interval starts; they are just never judged.
    init?(_ target: PlanTarget) {
        switch target {
        case .open, .zone:
            return nil
        case .speed(let low, let high, _):
            self.init(metric: .speed, low: low, high: high)
        case .cadence(let low, let high):
            self.init(metric: .cadence, low: low, high: high)
        case .heartRate(let low, let high):
            guard let band = Self.absolute(low, high) else { return nil }
            self.init(metric: .heartRate, low: band.low, high: band.high)
        case .power(let low, let high):
            guard let band = Self.absolute(low, high) else { return nil }
            self.init(metric: .power, low: band.low, high: band.high)
        }
    }

    private init?(metric: Metric, low: Double?, high: Double?) {
        guard low != nil || high != nil else { return nil }
        self.metric = metric
        self.low = low
        self.high = high
    }

    /// Both ends in the unit they are measured in, or nil where either is a percentage.
    private static func absolute(_ low: PlanBound?, _ high: PlanBound?) -> (low: Double?, high: Double?)? {
        if let low, !low.isAbsolute { return nil }
        if let high, !high.isAbsolute { return nil }
        return (low?.value, high?.value)
    }

    /// One reading, and what to say about it — nil almost every time, which is the point.
    mutating func read(_ value: Double?, at now: Date) -> String? {
        guard let value else {
            // A sensor that stopped reporting is not an athlete who drifted, so the drift
            // being counted is dropped rather than allowed to mature into an announcement.
            drifting = nil
            return nil
        }

        let side: Side
        if let high, value > high { side = .above } else if let low, value < low { side = .below } else { side = .inside }

        guard side != said else {
            drifting = nil
            return nil
        }

        if drifting?.side != side { drifting = (side, now) }
        guard let drifting, now.timeIntervalSince(drifting.since) >= Self.dwell else { return nil }

        said = side
        self.drifting = nil
        return phrase(for: side)
    }

    /// A cyclist above their power band is working too hard; a runner above their speed band
    /// is running too fast. Same side, different sentence.
    private func phrase(for side: Side) -> String {
        switch (side, metric) {
        case (.inside, _): return "back on target"
        case (.above, .speed): return "too fast"
        case (.below, .speed): return "too slow"
        case (.above, _): return "above target"
        case (.below, _): return "below target"
        }
    }
}

#endif
