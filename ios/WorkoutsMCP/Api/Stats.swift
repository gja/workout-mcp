// The numbers the server worked out from the recorded file, as the app reads them back.
//
// Nothing here is computed on the phone. The session was reduced once, in the Worker, and
// `GET /api/workouts/:date/:id/stats` hands back that same document — totals, a lap per
// segment of the recording, each lap's quarters and the band it was run against. Re-deriving
// any of it here would be a second set of answers to the same question. See docs/stats.md.

import Foundation

/// A workout carries the totals; the laps are their own read.
struct StatsSummary: Decodable, Hashable {
    let platform: String
    let activityId: String
    let computedAt: String?
    let session: SessionTotals?
    let flags: [String]
    /// Why there is nothing else here. Only ever set beside a `source_unreadable` flag.
    let error: String?
}

/// The whole document, laps included, and the athlete's own note on how it went.
struct WorkoutStats: Decodable {
    let platform: String
    let activityId: String
    let computedAt: String?
    let session: SessionTotals?
    let laps: [LapLine]
    let flags: [String]
    let comment: String?
    let error: String?

    /// Whether the laps were paired with the plan at all. A recording the server could not
    /// line up comes back with every lap unmatched, and a table of steps nobody ran is worse
    /// than none — see `laps_do_not_match_plan` in docs/stats.md.
    var isMatchedToPlan: Bool { laps.contains { $0.plannedStepIndex != nil } }
}

/// Missing is `null`, never `0`: a zero heart rate is a lap run without a strap, and reading
/// it as a measurement corrupts every average downstream.
struct SessionTotals: Decodable, Hashable {
    let sport: String?
    let subSport: String?
    /// No position was recorded, so pace, distance and elevation are the sensor's word alone.
    let indoor: Bool?
    let startTime: String?
    let elapsedS: Double?
    let movingS: Double?
    let timerS: Double?
    let distanceM: Double?
    let avgHr: Double?
    let maxHr: Double?
    let minHr: Double?
    let avgPaceSKm: Double?
    let avgCadence: Double?
    let avgPowerW: Double?
    let maxPowerW: Double?
    let normalizedPowerW: Double?
    let workKj: Double?
    /// Normalized over average power: how evenly the session was ridden.
    let variabilityIndex: Double?
    let totalAscentM: Double?
    let totalDescentM: Double?
    let calories: Double?
}

/// One segment of the recording, against the planned step the server paired it with.
struct LapLine: Decodable, Identifiable, Hashable {
    let index: Int
    /// What ended the lap: `manual`, `time`, `distance`… as FIT names it.
    let trigger: String?
    let role: String
    /// Which time round a repeat block this lap is, or null outside one.
    let repNumber: Int?
    let plannedStepIndex: Int?
    let plannedStepName: String?
    /// `high`, `low`, or `unmatched`. See the two bars in docs/stats.md.
    let matchConfidence: String
    let durationS: Double?
    let movingS: Double?
    let distanceM: Double?
    let avgHr: Double?
    let maxHr: Double?
    /// How far heart rate fell. The signal a recovery lap exists to produce, and invisible
    /// in an average.
    let minHr: Double?
    let avgPaceSKm: Double?
    let avgCadence: Double?
    let avgPowerW: Double?
    let maxPowerW: Double?
    let normalizedPowerW: Double?
    let elevGainM: Double?
    let elevLossM: Double?
    /// Where the lap finished against where it started, and the average grade between.
    let elevNetM: Double?
    let avgGradePct: Double?
    let quarters: Quarters?
    let target: LapTarget?
    let flags: [String]

    var id: Int { index }

    /// What to call this lap: the planned step where it was paired with one, and what the
    /// file itself said it was where it was not.
    var title: String { plannedStepName ?? role.replacingOccurrences(of: "_", with: " ").capitalized }
}

/// Four equal segments of a lap, each metric averaged within its own. This is what makes
/// the averages trustworthy: a rep that starts fast and decays averages out to a clean hit,
/// and the quarters expose it. Null under 60 seconds, where quartering measures noise.
struct Quarters: Decodable, Hashable {
    /// `time` or `distance` — whichever the step was prescribed in.
    let splitBy: String
    let hr: [Double?]?
    let paceSKm: [Double?]?
    let powerW: [Double?]?
    let cadence: [Double?]?
    /// What the ground did: the end of each quarter minus its start, and how steep.
    let elevNetM: [Double?]?
    let gradePct: [Double?]?
}

/// The planned band this lap was run against, and how much of it was spent inside.
/// Only absolute targets are here: a zone or a percentage is a number the athlete's own
/// platform profile holds, so the server emits nothing rather than inventing bounds.
struct LapTarget: Decodable, Hashable {
    /// `hr`, `pace_s_km`, `power_w` or `cadence`. Pace is seconds per km, so `low` is faster.
    let metric: String
    let low: Double
    let high: Double
    let pctTimeInBand: Double
    let pctTimeAbove: Double
    let pctTimeBelow: Double
}
