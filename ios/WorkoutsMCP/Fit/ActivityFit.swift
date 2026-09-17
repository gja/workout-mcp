// A recorded session as a FIT activity file: file_id, the records, one lap a segment,
// the session, and the activity that closes it. What the server reads back out of it
// is docs/stats.md; the shape of the file itself is ios/README.md.

import Foundation

/// FIT's `sport` enum, as far as this app goes.
enum FitSport: Int {
    case generic = 0
    case running = 1
    case cycling = 2
    case swimming = 5
    case training = 10
    case walking = 11
    case rowing = 15
    case hiking = 17

    /// FIT counts one leg per cycle for a runner; an athlete counts both, and so does the server.
    var halvesCadence: Bool { self == .running || self == .walking || self == .hiking }
}

enum FitSubSport: Int {
    case generic = 0
    case treadmill = 1
    case street = 2
    case trail = 3
    case track = 4
    case spin = 5
    case indoorCycling = 6
    case road = 7
    case mountain = 8
    case indoorRowing = 14
    case indoorWalking = 27
    case virtualActivity = 58
}

/// One second of the recording. Everything is optional: a sensor that was not worn
/// writes nothing, and nothing is the honest reading of that.
struct RecordedSample {
    let time: Date
    var latitude: Double?
    var longitude: Double?
    var altitude: Double?
    /// Cumulative metres from the start of the session, as FIT stores distance.
    var distance: Double?
    var speed: Double?
    var heartRate: Double?
    /// Steps or revolutions a minute, the way the athlete counts them.
    var cadence: Double?
    var power: Double?
}

/// A segment of the recording: an interval the watch marked, or the whole session.
struct RecordedLap {
    let start: Date
    let end: Date
}

struct RecordedSession {
    let sport: FitSport
    let subSport: FitSubSport
    let start: Date
    let end: Date
    /// Time the watch was actually recording, which is under elapsed where it was paused.
    let movingSeconds: Double
    let samples: [RecordedSample]
    let laps: [RecordedLap]
    let calories: Double?
    /// `<date>/<id>` of the planned workout this session was, where that is known.
    let workoutKey: String?
}

enum ActivityFit {
    /// The application a developer field is declared under. Fixed, so every file this app
    /// writes declares the same one and a reader can recognise it.
    private static let applicationID: [UInt8] = [
        0x77, 0x6F, 0x72, 0x6B, 0x6F, 0x75, 0x74, 0x73, 0x6D, 0x63, 0x70, 0x00, 0x00, 0x00, 0x00, 0x01,
    ]

    private static let workoutKeyField: UInt8 = 0
    private static let workoutKeyCapacity = 64

    static func encode(_ session: RecordedSession) -> Data {
        var writer = FitWriter()

        writer.append(FitMessage(global: 0, fields: [
            FitField(0, .enumerated(4)), // an activity file
            FitField(1, .uint16(255)), // manufacturer: development
            FitField(2, .uint16(1)),
            FitField(3, .uint32z(Double(UInt32(truncatingIfNeeded: Int(session.start.timeIntervalSince1970))))),
            FitField(4, .timestamp(session.start)),
            FitField(8, .text("WorkoutsMCP", capacity: 16)),
        ]))

        if session.workoutKey != nil { declareWorkoutKeyField(&writer) }

        writer.append(timerEvent(at: session.start, starting: true))
        for sample in session.samples { writer.append(record(sample, sport: session.sport)) }
        writer.append(timerEvent(at: session.end, starting: false))

        let laps = session.laps.isEmpty ? [RecordedLap(start: session.start, end: session.end)] : session.laps
        for (index, lap) in laps.enumerated() {
            writer.append(self.lap(lap, index: index, of: session, last: index == laps.count - 1))
        }

        writer.append(sessionMessage(session, laps: laps.count))
        writer.append(FitMessage(global: 34, fields: [
            FitField(253, .timestamp(session.end)),
            FitField(0, .uint32(session.end.timeIntervalSince(session.start), scale: 1000)),
            FitField(1, .uint16(1)),
            FitField(2, .enumerated(0)), // a manual activity: one sport, recorded by hand
            FitField(3, .enumerated(26)), // event: activity
            FitField(4, .enumerated(1)), // event_type: stop
            FitField(5, .timestamp(session.end.addingTimeInterval(Double(TimeZone.current.secondsFromGMT(for: session.end))))),
        ]))

        return writer.finish()
    }

    // --- The messages ----------------------------------------------------------

    /// `developer_data_id` and `field_description`, which every developer field needs ahead of it.
    private static func declareWorkoutKeyField(_ writer: inout FitWriter) {
        writer.append(FitMessage(global: 207, fields: [
            FitField(1, .bytes(applicationID)),
            FitField(3, .uint8(0)),
        ]))
        writer.append(FitMessage(global: 206, fields: [
            FitField(0, .uint8(0)),
            FitField(1, .uint8(Double(workoutKeyField))),
            FitField(2, .uint8(Double(FitBaseType.string.rawValue))),
            FitField(3, .text("workout_mcp_id", capacity: 24)),
        ]))
    }

    private static func timerEvent(at time: Date, starting: Bool) -> FitMessage {
        FitMessage(global: 21, fields: [
            FitField(253, .timestamp(time)),
            FitField(0, .enumerated(0)), // event: timer
            FitField(1, .enumerated(starting ? 0 : 4)), // event_type: start / stop_all
            FitField(4, .uint8(0)),
        ])
    }

    private static func record(_ sample: RecordedSample, sport: FitSport) -> FitMessage {
        // Halved on the way in, because a FIT cadence is one leg and the server doubles it back.
        let cadence = sample.cadence.map { sport.halvesCadence ? $0 / 2 : $0 }

        return FitMessage(global: 20, fields: [
            FitField(253, .timestamp(sample.time)),
            FitField(0, .semicircles(sample.latitude)),
            FitField(1, .semicircles(sample.longitude)),
            FitField(5, .uint32(sample.distance, scale: 100)),
            FitField(73, .uint32(sample.speed, scale: 1000)),
            FitField(78, .uint32(sample.altitude, scale: 5, offset: 500)),
            FitField(3, .uint8(sample.heartRate)),
            FitField(4, .uint8(cadence)),
            FitField(7, .uint16(sample.power)),
        ])
    }

    private static func lap(_ lap: RecordedLap, index: Int, of session: RecordedSession, last: Bool) -> FitMessage {
        let seconds = lap.end.timeIntervalSince(lap.start)
        let window = Summary(session.samples, from: lap.start, to: lap.end, over: seconds, sport: session.sport)

        return FitMessage(global: 19, fields: [
            FitField(254, .uint16(Double(index))),
            FitField(253, .timestamp(lap.end)),
            FitField(2, .timestamp(lap.start)),
            FitField(0, .enumerated(9)), // event: lap
            FitField(1, .enumerated(1)), // event_type: stop
            FitField(7, .uint32(seconds, scale: 1000)),
            FitField(8, .uint32(seconds, scale: 1000)),
            FitField(52, .uint32(seconds, scale: 1000)),
            FitField(9, .uint32(window.distance, scale: 100)),
            FitField(110, .uint32(window.averageSpeed, scale: 1000)),
            FitField(111, .uint32(window.maximumSpeed, scale: 1000)),
            FitField(15, .uint8(window.averageHeartRate)),
            FitField(16, .uint8(window.maximumHeartRate)),
            FitField(63, .uint8(window.minimumHeartRate)),
            FitField(17, .uint8(window.averageCadence)),
            FitField(19, .uint16(window.averagePower)),
            FitField(20, .uint16(window.maximumPower)),
            FitField(23, .enumerated(0)), // intensity: active. The plan says which step it was.
            // The last lap is the one the athlete did not press: the session ended under it.
            FitField(24, .enumerated(last ? 7 : 0)),
            FitField(25, .enumerated(session.sport.rawValue)),
        ])
    }

    private static func sessionMessage(_ session: RecordedSession, laps: Int) -> FitMessage {
        let elapsed = session.end.timeIntervalSince(session.start)
        let whole = Summary(
            session.samples, from: session.start, to: session.end,
            // Over moving time, not elapsed: a session paused at a crossing was not slower for it.
            over: session.movingSeconds > 0 ? session.movingSeconds : elapsed,
            sport: session.sport
        )

        var message = FitMessage(global: 18, fields: [
            FitField(254, .uint16(0)),
            FitField(253, .timestamp(session.end)),
            FitField(2, .timestamp(session.start)),
            FitField(0, .enumerated(8)), // event: session
            FitField(1, .enumerated(1)), // event_type: stop
            FitField(28, .enumerated(0)), // trigger: the activity ending
            FitField(5, .enumerated(session.sport.rawValue)),
            FitField(6, .enumerated(session.subSport.rawValue)),
            FitField(7, .uint32(elapsed, scale: 1000)),
            FitField(8, .uint32(session.movingSeconds, scale: 1000)),
            FitField(59, .uint32(session.movingSeconds, scale: 1000)),
            FitField(9, .uint32(whole.distance, scale: 100)),
            FitField(124, .uint32(whole.averageSpeed, scale: 1000)),
            FitField(125, .uint32(whole.maximumSpeed, scale: 1000)),
            FitField(16, .uint8(whole.averageHeartRate)),
            FitField(17, .uint8(whole.maximumHeartRate)),
            FitField(64, .uint8(whole.minimumHeartRate)),
            FitField(18, .uint8(whole.averageCadence)),
            FitField(20, .uint16(whole.averagePower)),
            FitField(21, .uint16(whole.maximumPower)),
            FitField(11, .uint16(session.calories)),
            FitField(25, .uint16(0)),
            FitField(26, .uint16(Double(laps))),
        ])

        if let key = session.workoutKey {
            message.developerFields = [
                FitDeveloperField(number: workoutKeyField, index: 0, value: .text(key, capacity: workoutKeyCapacity)),
            ]
        }
        return message
    }
}

/// The averages and extremes over one window of the recording. Absent where nothing
/// was measured, which is what an absent FIT field means and a zero would not.
private struct Summary {
    var distance: Double?
    var averageSpeed: Double?
    var maximumSpeed: Double?
    var averageHeartRate: Double?
    var maximumHeartRate: Double?
    var minimumHeartRate: Double?
    var averageCadence: Double?
    var averagePower: Double?
    var maximumPower: Double?

    init(_ samples: [RecordedSample], from: Date, to: Date, over seconds: Double, sport: FitSport) {
        let window = samples.filter { $0.time >= from && $0.time <= to }
        guard !window.isEmpty else { return }

        if let first = window.compactMap({ $0.distance }).first, let last = window.compactMap({ $0.distance }).last {
            distance = max(0, last - first)
        }

        if let distance, seconds > 0 { averageSpeed = distance / seconds }
        maximumSpeed = window.compactMap(\.speed).max()

        let heartRates = window.compactMap(\.heartRate).filter { $0 > 0 }
        averageHeartRate = Summary.mean(heartRates)
        maximumHeartRate = heartRates.max()
        minimumHeartRate = heartRates.min()

        let cadences = window.compactMap(\.cadence).filter { $0 > 0 }
        averageCadence = Summary.mean(cadences).map { sport.halvesCadence ? $0 / 2 : $0 }

        let powers = window.compactMap(\.power).filter { $0 > 0 }
        averagePower = Summary.mean(powers)
        maximumPower = powers.max()
    }

    private static func mean(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }
}
