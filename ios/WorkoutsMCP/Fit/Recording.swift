// A recorded session in the shape a FIT activity file wants, and the figures derived
// from it. Nothing here knows about HealthKit; `Health/SessionReader.swift` fills it in.

import FITSwiftSDK
import Foundation

/// One second of the recording. Every channel is optional: a sensor that was not worn
/// records nothing, and nothing is the honest reading of that — never zero, which the
/// server would read as a measurement. See docs/stats.md.
struct RecordedSample {
    let time: Date

    var latitude: Double?
    var longitude: Double?
    /// Metres above sea level.
    var altitude: Double?
    /// The horizontal error on the fix, in metres.
    var positionAccuracy: Double?

    /// Cumulative metres from the start of the session, as FIT stores distance.
    var distance: Double?
    /// Metres a second.
    var speed: Double?
    /// Metres a second upwards, which is a climb rate rather than a pace.
    var verticalSpeed: Double?
    /// Percent, rise over run.
    var grade: Double?

    var heartRate: Double?
    /// Steps or crank revolutions a minute, the way the athlete counts them.
    var cadence: Double?
    var power: Double?
    /// Cumulative kilocalories.
    var calories: Double?

    /// Running dynamics: millimetres, milliseconds, metres.
    var verticalOscillation: Double?
    var groundContactTime: Double?
    var strideLength: Double?

    /// Breaths a minute.
    var respirationRate: Double?
}

/// A segment of the recording: an interval the watch marked, or the whole session.
struct RecordedLap {
    let start: Date
    let end: Date
}

struct RecordedSession {
    let sport: Sport
    let subSport: SubSport
    let start: Date
    let end: Date
    /// Time the watch was actually recording, which is under elapsed where it was paused.
    let movingSeconds: Double
    let samples: [RecordedSample]
    let laps: [RecordedLap]
    /// `<date>/<id>` of the planned workout this session was, where that is known.
    let workoutKey: String?
}

extension Sport {
    /// FIT counts one leg per cycle for a runner; an athlete counts both, and so does the
    /// server, which doubles it back on the way in. See "Units and nulls" in docs/stats.md.
    var halvesCadence: Bool { self == .running || self == .walking || self == .hiking }
}

/// Everything a `session` or a `lap` message carries, worked out over one window of the
/// recording. Absent where nothing was measured.
///
/// The two figures with a method rather than a formula — elevation and normalized power —
/// are computed the way the server computes them when a file leaves them out, so a file
/// this app writes and one it does not read the same. See docs/stats.md.
struct RecordedSummary {
    /// How far altitude has to move before it counts as climbing rather than sensor drift.
    private static let elevationNoise = 3.0

    /// The window a normalized-power average rolls over, as Coggan defined it. Samples are
    /// one a second, so a count is a number of seconds.
    private static let normalizedWindow = 30

    var distance: Double?
    var averageSpeed: Double?
    var maximumSpeed: Double?
    var averageHeartRate: Double?
    var maximumHeartRate: Double?
    var minimumHeartRate: Double?
    var averageCadence: Double?
    var maximumCadence: Double?
    var averagePower: Double?
    var maximumPower: Double?
    var normalizedPower: Double?
    /// Joules, which is what FIT's `total_work` is in.
    var work: Double?
    var ascent: Double?
    var descent: Double?
    var averageAltitude: Double?
    var maximumAltitude: Double?
    var minimumAltitude: Double?
    var averageGrade: Double?
    var calories: Double?
    /// Steps, or crank revolutions, as FIT counts them: one leg per cycle.
    var cycles: Double?
    var averageVerticalOscillation: Double?
    var averageGroundContactTime: Double?
    var averageStrideLength: Double?
    var averageRespirationRate: Double?

    var startPosition: (latitude: Double, longitude: Double)?
    var endPosition: (latitude: Double, longitude: Double)?
    /// The corners of the box the session fits in: north-east and south-west.
    var northEast: (latitude: Double, longitude: Double)?
    var southWest: (latitude: Double, longitude: Double)?

    init(_ samples: [RecordedSample], from: Date, to: Date, over seconds: Double, sport: Sport) {
        let window = samples.filter { $0.time >= from && $0.time <= to }
        guard !window.isEmpty else { return }

        let distances = window.compactMap(\.distance)
        if let first = distances.first, let last = distances.last { distance = max(0, last - first) }
        if let distance, seconds > 0 { averageSpeed = distance / seconds }
        maximumSpeed = window.compactMap(\.speed).max()

        let heartRates = window.compactMap(\.heartRate).filter { $0 > 0 }
        averageHeartRate = Self.mean(heartRates)
        maximumHeartRate = heartRates.max()
        minimumHeartRate = heartRates.min()

        // Halved on the way in, because a FIT cadence is one leg and the server doubles it back.
        let halve = { (rate: Double) in sport.halvesCadence ? rate / 2 : rate }
        let cadences = window.compactMap(\.cadence).filter { $0 > 0 }
        averageCadence = Self.mean(cadences).map(halve)
        maximumCadence = cadences.max().map(halve)
        if let averageCadence, seconds > 0 { cycles = averageCadence * seconds / 60 }

        let powers = window.compactMap(\.power).filter { $0 >= 0 }
        averagePower = Self.mean(powers)
        maximumPower = powers.max()
        normalizedPower = Self.normalizedPower(powers)
        // One sample a second, so a watt held for a sample is a joule.
        work = powers.isEmpty ? nil : powers.reduce(0, +)

        let altitudes = window.compactMap(\.altitude)
        averageAltitude = Self.mean(altitudes)
        maximumAltitude = altitudes.max()
        minimumAltitude = altitudes.min()
        if !altitudes.isEmpty {
            let climb = Self.climb(altitudes)
            ascent = climb.gain
            descent = climb.loss
        }
        if let distance, distance > 0, let ascent, let descent {
            averageGrade = (ascent - descent) / distance * 100
        }

        let burned = window.compactMap(\.calories)
        if let first = burned.first, let last = burned.last { calories = max(0, last - first) }

        averageVerticalOscillation = Self.mean(window.compactMap(\.verticalOscillation))
        averageGroundContactTime = Self.mean(window.compactMap(\.groundContactTime))
        averageStrideLength = Self.mean(window.compactMap(\.strideLength))
        averageRespirationRate = Self.mean(window.compactMap(\.respirationRate))

        let located = window.filter { $0.latitude != nil && $0.longitude != nil }
        if let first = located.first { startPosition = (first.latitude!, first.longitude!) }
        if let last = located.last { endPosition = (last.latitude!, last.longitude!) }
        if !located.isEmpty {
            let latitudes = located.map { $0.latitude! }
            let longitudes = located.map { $0.longitude! }
            northEast = (latitudes.max()!, longitudes.max()!)
            southWest = (latitudes.min()!, longitudes.min()!)
        }
    }

    private static func mean(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }

    /// A rise counts only once it clears the sensor's noise, and from wherever the last one
    /// was counted from. Summing an unsmoothed trace turns drift into hundreds of metres.
    private static func climb(_ altitudes: [Double]) -> (gain: Double, loss: Double) {
        var gain = 0.0
        var loss = 0.0
        var anchor = altitudes[0]

        for altitude in altitudes.dropFirst() {
            let moved = altitude - anchor
            if moved >= elevationNoise {
                gain += moved
                anchor = altitude
            } else if moved <= -elevationNoise {
                loss -= moved
                anchor = altitude
            }
        }
        return (gain, loss)
    }

    /// Coggan's method: a rolling 30-second average, raised to the fourth, averaged, rooted
    /// back. Refused outright for anything shorter than the window, where it means nothing.
    private static func normalizedPower(_ powers: [Double]) -> Double? {
        guard powers.count >= normalizedWindow else { return nil }

        var rolling: [Double] = []
        var window: [Double] = []
        var sum = 0.0

        for power in powers {
            window.append(power)
            sum += power
            if window.count > normalizedWindow { sum -= window.removeFirst() }
            if window.count == normalizedWindow { rolling.append(sum / Double(normalizedWindow)) }
        }

        guard !rolling.isEmpty else { return nil }
        return pow(rolling.reduce(0) { $0 + pow($1, 4) } / Double(rolling.count), 0.25)
    }
}
