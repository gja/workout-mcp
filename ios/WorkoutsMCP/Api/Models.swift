// What the server sends back. The plan arrives already resolved — one duration and up
// to two targets a step — from `GET /api/workout-plans`, so nothing here has to
// re-implement the resolver in docs/workouts.md.

import Foundation

struct PlannedWorkout: Decodable, Identifiable, Hashable {
    let id: String
    let date: String
    let name: String
    let sport: String
    let subSport: String?
    let notes: String?
    let summary: String?
    /// The athlete's own note on how it went, written after the session. Not `notes`.
    let comment: String?
    let tags: [String]?
    let completedAt: String?
    /// What the plan adds up to. The server computes it on every listing, so nothing here
    /// walks the steps to say "1 h 15 · 12 km".
    let planned: PlannedTotals?
    /// The recorded session's totals. The laps behind them are their own read — see
    /// `WorkoutsClient.stats(for:)` and docs/stats.md.
    let stats: StatsSummary?
    /// When the server last wrote this row. The sync keeps it against what it put on the
    /// watch, so an unchanged workout is not sent again — see `PlanPlacement`. Optional
    /// because a deployment older than that is answered by syncing everything, as before.
    let updatedAt: String?

    /// How this workout is addressed, everywhere: in a URL, in a FIT file, in a scheduled plan.
    var key: String { "\(date)/\(id)" }
    /// The same pair as `plan-ids` and `/export` spell it, with no slash to encode.
    /// Not `PlanLink.planID`, which is what Apple's scheduler holds this workout under.
    var slug: String { "\(date)-\(id)" }
    var isDone: Bool { completedAt != nil }

    var day: Date? { WorkoutDate.parse(date) }
    var doneAt: Date? { Timestamps.parse(completedAt) }
}

/// A floor, not an estimate: `openSteps` counts the steps that run until a lap press.
struct PlannedTotals: Decodable, Hashable {
    let seconds: Double
    let meters: Double
    let steps: Int
    let openSteps: Int
}

struct ResolvedPlan: Decodable {
    let date: String
    let id: String
    let name: String
    let sport: String
    let subSport: String?
    let steps: [ResolvedStep]

    var key: String { "\(date)/\(id)" }
}

/// `GET /api/workout-plans`: what was found, and what the server no longer has. A plan in
/// `missing` is a workout deleted or moved since the listing, which is an answer rather
/// than a failure — see docs/api.md.
struct PlanBatch: Decodable {
    let plans: [ResolvedPlan]
    let missing: [String]
}

/// A step, or a block of them run several times. The server's `resolveSteps` shape.
indirect enum ResolvedStep: Decodable {
    case effort(PlanEffort)
    case block(times: Int, steps: [ResolvedStep])

    private enum CodingKeys: String, CodingKey { case kind, times, steps }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decode(String.self, forKey: .kind) == "repeat" {
            self = .block(
                times: try container.decode(Int.self, forKey: .times),
                steps: try container.decode([ResolvedStep].self, forKey: .steps)
            )
        } else {
            self = .effort(try PlanEffort(from: decoder))
        }
    }
}

struct PlanEffort: Decodable {
    let name: String?
    let notes: String?
    let intensity: String
    let duration: PlanDuration
    let target: PlanTarget
    let secondaryTarget: PlanTarget?

    /// Which of the six intensities the plan gave this step, as Apple's scheduler sees it.
    var isRecovery: Bool { intensity == "rest" || intensity == "recovery" }
}

enum PlanDuration: Decodable {
    case open
    case time(seconds: Double)
    case distance(meters: Double)

    private enum CodingKeys: String, CodingKey { case type, seconds, meters }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "time": self = .time(seconds: try container.decode(Double.self, forKey: .seconds))
        case "distance": self = .distance(meters: try container.decode(Double.self, forKey: .meters))
        default: self = .open
        }
    }
}

/// A bound the plan wrote as an absolute number or as a percentage of something only the
/// athlete's own profile knows. The percentage forms are carried, not converted.
struct PlanBound: Decodable {
    let unit: String
    let value: Double

    var isAbsolute: Bool { unit == "bpm" || unit == "watts" }
}

enum PlanTarget: Decodable {
    case open
    case zone(metric: String, zone: Int)
    case heartRate(low: PlanBound?, high: PlanBound?)
    /// Metres a second, both ends, with the unit the athlete wrote the pace in so it can be
    /// shown back the same way round.
    case speed(low: Double?, high: Double?, unit: String)
    case power(low: PlanBound?, high: PlanBound?)
    case cadence(low: Double?, high: Double?)

    private enum CodingKeys: String, CodingKey { case type, metric, zone, low, high, unit }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "zone":
            self = .zone(
                metric: try container.decode(String.self, forKey: .metric),
                zone: try container.decode(Int.self, forKey: .zone)
            )
        case "heart_rate":
            self = .heartRate(
                low: try container.decodeIfPresent(PlanBound.self, forKey: .low),
                high: try container.decodeIfPresent(PlanBound.self, forKey: .high)
            )
        case "speed":
            self = .speed(
                low: try container.decodeIfPresent(Double.self, forKey: .low),
                high: try container.decodeIfPresent(Double.self, forKey: .high),
                unit: try container.decodeIfPresent(String.self, forKey: .unit) ?? "km"
            )
        case "power":
            self = .power(
                low: try container.decodeIfPresent(PlanBound.self, forKey: .low),
                high: try container.decodeIfPresent(PlanBound.self, forKey: .high)
            )
        case "cadence":
            self = .cadence(
                low: try container.decodeIfPresent(Double.self, forKey: .low),
                high: try container.decodeIfPresent(Double.self, forKey: .high)
            )
        default:
            self = .open
        }
    }
}

/// What `POST .../recording` answers with: the workout, now done, and what was read off the file.
struct RecordingReceipt: Decodable {
    let date: String
    let id: String
    /// What the workout is called, which is the whole of what a notification wants to say.
    /// The server has always sent it; nothing here read it until something had to.
    let name: String?
    let completedAt: String?
    let stats: StatsSummary?
}

/// The server keeps a fortnight ahead and a week behind; dates are plain `YYYY-MM-DD`.
enum WorkoutDate {
    static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// Read in the athlete's own timezone: the day a workout sits on is their day, not UTC's.
    static func parse(_ text: String) -> Date? {
        formatter.timeZone = TimeZone.current
        return formatter.date(from: text)
    }

    static func string(_ date: Date) -> String {
        formatter.timeZone = TimeZone.current
        return formatter.string(from: date)
    }
}

/// Timestamps the server writes: RFC 3339, and with milliseconds on the ones it generates
/// itself, which the plain parser rejects outright rather than ignoring.
enum Timestamps {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole = ISO8601DateFormatter()

    static func parse(_ text: String?) -> Date? {
        guard let text else { return nil }
        return fractional.date(from: text) ?? whole.date(from: text)
    }
}
