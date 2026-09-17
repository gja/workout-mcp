// A recorded session as a FIT activity file, written with Garmin's own Swift SDK.
//
// The SDK owns the wire format: the header, both CRCs, definition and data records, the
// profile's scaling. Every setter here takes a real unit — metres, metres a second, watts
// — and the SDK scales it. What this file decides is only which messages an activity needs
// and what goes in them. See docs/ios.md.

import FITSwiftSDK
import Foundation

enum ActivityFit {
    /// The application every developer field here is declared under. Fixed, so a reader can
    /// recognise a file this app wrote: "776f726b-6f75-7473-6d63-700000000001".
    private static let applicationID: [UInt8] = [
        0x77, 0x6F, 0x72, 0x6B, 0x6F, 0x75, 0x74, 0x73, 0x6D, 0x63, 0x70, 0x00, 0x00, 0x00, 0x00, 0x01,
    ]

    private static let workoutKeyField: UInt8 = 0
    private static let productName = "WorkoutsMCP"

    static func encode(_ session: RecordedSession) throws -> Data {
        let encoder = Encoder()
        let start = DateTime(date: session.start)
        let end = DateTime(date: session.end)

        // The combination of file type, manufacturer, product and serial should be unique,
        // and stable for a given session so the same recording encodes to the same file.
        let serial = UInt32(truncatingIfNeeded: Int(session.start.timeIntervalSince1970))

        let fileID = FileIdMesg()
        try fileID.setType(.activity)
        try fileID.setManufacturer(.development)
        try fileID.setProduct(0)
        try fileID.setSerialNumber(serial)
        try fileID.setTimeCreated(start)
        encoder.write(mesg: fileID)

        let device = DeviceInfoMesg()
        try device.setTimestamp(start)
        try device.setManufacturer(.development)
        try device.setProduct(0)
        try device.setProductName(productName)
        try device.setSerialNumber(serial)
        encoder.write(mesg: device)

        let developerID = DeveloperDataIdMesg()
        for (index, byte) in applicationID.enumerated() {
            try developerID.setApplicationId(index: index, value: byte)
        }
        try developerID.setDeveloperDataIndex(0)
        try developerID.setApplicationVersion(1)
        encoder.write(mesg: developerID)

        let workoutKeyDescription = FieldDescriptionMesg()
        try workoutKeyDescription.setDeveloperDataIndex(0)
        try workoutKeyDescription.setFieldDefinitionNumber(workoutKeyField)
        try workoutKeyDescription.setFitBaseTypeId(.string)
        try workoutKeyDescription.setFieldName(index: 0, value: "workout_mcp_id")
        try workoutKeyDescription.setNativeMesgNum(.session)
        encoder.write(mesg: workoutKeyDescription)

        // Timer events around the records are a best practice for an activity file.
        encoder.write(mesg: try timerEvent(at: start, starting: true))
        for sample in session.samples {
            encoder.write(mesg: try record(sample, sport: session.sport))
        }
        encoder.write(mesg: try timerEvent(at: end, starting: false))

        let laps = session.laps.isEmpty ? [RecordedLap(start: session.start, end: session.end)] : session.laps
        for (index, lap) in laps.enumerated() {
            encoder.write(mesg: try self.lap(lap, index: index, of: session, last: index == laps.count - 1))
        }

        encoder.write(mesg: try sessionMesg(session, laps: laps.count, developerID: developerID, keyField: workoutKeyDescription))

        let activity = ActivityMesg()
        try activity.setTimestamp(end)
        try activity.setTotalTimerTime(session.movingSeconds)
        try activity.setNumSessions(1)
        try activity.setType(.manual)
        try activity.setEvent(.activity)
        try activity.setEventType(.stop)
        try activity.setLocalTimestamp(LocalDateTime(Int(end.timestamp) + TimeZone.current.secondsFromGMT(for: session.end)))
        encoder.write(mesg: activity)

        return encoder.close()
    }

    // --- The messages ------------------------------------------------------------------

    private static func timerEvent(at time: DateTime, starting: Bool) throws -> EventMesg {
        let event = EventMesg()
        try event.setTimestamp(time)
        try event.setEvent(.timer)
        try event.setEventType(starting ? .start : .stopAll)
        return event
    }

    private static func record(_ sample: RecordedSample, sport: Sport) throws -> RecordMesg {
        let mesg = RecordMesg()
        try mesg.setTimestamp(DateTime(date: sample.time))

        try set(sample.latitude) { try mesg.setPositionLat(semicircles($0)) }
        try set(sample.longitude) { try mesg.setPositionLong(semicircles($0)) }
        try set(sample.positionAccuracy) { try mesg.setGpsAccuracy(UInt8(clamping: Int($0.rounded()))) }

        // Both spellings: `enhanced_*` is the one anything modern reads, and the plain field
        // keeps an older reader from seeing a session with no speed or altitude at all.
        try set(sample.altitude) {
            try mesg.setEnhancedAltitude($0)
            try mesg.setAltitude($0)
        }
        try set(sample.speed) {
            try mesg.setEnhancedSpeed($0)
            try mesg.setSpeed($0)
        }

        try set(sample.distance) { try mesg.setDistance($0) }
        try set(sample.verticalSpeed) { try mesg.setVerticalSpeed($0) }
        try set(sample.grade) { try mesg.setGrade($0) }
        try set(sample.heartRate) { try mesg.setHeartRate(UInt8(clamping: Int($0.rounded()))) }
        try set(sample.power) { try mesg.setPower(UInt16(clamping: Int($0.rounded()))) }
        try set(sample.calories) { try mesg.setCalories(UInt16(clamping: Int($0.rounded()))) }

        // A FIT cadence is one leg per cycle for a runner; the half a stride that leaves over
        // has its own field rather than being rounded away.
        try set(sample.cadence) { rate in
            let cycles = sport.halvesCadence ? rate / 2 : rate
            try mesg.setCadence(UInt8(clamping: Int(cycles.rounded(.down))))
            try mesg.setFractionalCadence(cycles - cycles.rounded(.down))
        }

        try set(sample.verticalOscillation) { try mesg.setVerticalOscillation($0) }
        try set(sample.groundContactTime) { try mesg.setStanceTime($0) }
        try set(sample.strideLength) { try mesg.setStepLength($0) }
        try set(sample.respirationRate) { try mesg.setEnhancedRespirationRate($0) }

        return mesg
    }

    private static func lap(_ lap: RecordedLap, index: Int, of session: RecordedSession, last: Bool) throws -> LapMesg {
        let seconds = lap.end.timeIntervalSince(lap.start)
        let summary = RecordedSummary(session.samples, from: lap.start, to: lap.end, over: seconds, sport: session.sport)

        let mesg = LapMesg()
        try mesg.setMessageIndex(MessageIndex(index))
        try mesg.setTimestamp(DateTime(date: lap.end))
        try mesg.setStartTime(DateTime(date: lap.start))
        try mesg.setEvent(.lap)
        try mesg.setEventType(.stop)
        try mesg.setSport(session.sport)
        try mesg.setSubSport(session.subSport)
        try mesg.setTotalElapsedTime(seconds)
        try mesg.setTotalTimerTime(seconds)
        try mesg.setTotalMovingTime(seconds)
        // The plan is what says which step this was; the file only says it was work.
        try mesg.setIntensity(.active)
        // The last lap is the one nobody pressed: the session ended underneath it.
        try mesg.setLapTrigger(last ? .sessionEnd : .manual)

        try apply(summary, to: mesg)
        return mesg
    }

    private static func sessionMesg(
        _ session: RecordedSession,
        laps: Int,
        developerID: DeveloperDataIdMesg,
        keyField: FieldDescriptionMesg
    ) throws -> SessionMesg {
        let elapsed = session.end.timeIntervalSince(session.start)
        let summary = RecordedSummary(
            session.samples, from: session.start, to: session.end,
            // Over moving time rather than elapsed: a session paused at a crossing was not
            // slower for it, and pace is the figure most often read off one of these files.
            over: session.movingSeconds > 0 ? session.movingSeconds : elapsed,
            sport: session.sport
        )

        let mesg = SessionMesg()
        try mesg.setMessageIndex(0)
        try mesg.setTimestamp(DateTime(date: session.end))
        try mesg.setStartTime(DateTime(date: session.start))
        try mesg.setEvent(.session)
        try mesg.setEventType(.stop)
        try mesg.setTrigger(.activityEnd)
        try mesg.setSport(session.sport)
        try mesg.setSubSport(session.subSport)
        try mesg.setTotalElapsedTime(elapsed)
        try mesg.setTotalTimerTime(session.movingSeconds)
        try mesg.setTotalMovingTime(session.movingSeconds)
        try mesg.setFirstLapIndex(0)
        try mesg.setNumLaps(UInt16(laps))

        try apply(summary, to: mesg)

        if let key = session.workoutKey {
            let field = DeveloperField(fieldDescription: keyField, developerDataIdMesg: developerID)
            try field.setValue(index: 0, value: key)
            mesg.setDeveloperField(field)
        }
        return mesg
    }

    // --- The figures, onto whichever message wants them ----------------------------------

    /// `lap` and `session` carry the same summary under the same setter names, so they are
    /// filled by the same code against the two small protocols below.
    private static func apply(_ summary: RecordedSummary, to mesg: some SummarisedMesg) throws {
        try set(summary.distance) { try mesg.setTotalDistance($0) }
        try set(summary.averageSpeed) {
            try mesg.setEnhancedAvgSpeed($0)
            try mesg.setAvgSpeed($0)
        }
        try set(summary.maximumSpeed) {
            try mesg.setEnhancedMaxSpeed($0)
            try mesg.setMaxSpeed($0)
        }
        try set(summary.averageHeartRate) { try mesg.setAvgHeartRate(UInt8(clamping: Int($0.rounded()))) }
        try set(summary.maximumHeartRate) { try mesg.setMaxHeartRate(UInt8(clamping: Int($0.rounded()))) }
        try set(summary.minimumHeartRate) { try mesg.setMinHeartRate(UInt8(clamping: Int($0.rounded()))) }
        try set(summary.averageCadence) { try mesg.setAvgCadence(UInt8(clamping: Int($0.rounded()))) }
        try set(summary.maximumCadence) { try mesg.setMaxCadence(UInt8(clamping: Int($0.rounded()))) }
        try set(summary.averagePower) { try mesg.setAvgPower(UInt16(clamping: Int($0.rounded()))) }
        try set(summary.maximumPower) { try mesg.setMaxPower(UInt16(clamping: Int($0.rounded()))) }
        try set(summary.normalizedPower) { try mesg.setNormalizedPower(UInt16(clamping: Int($0.rounded()))) }
        try set(summary.work) { try mesg.setTotalWork(UInt32(clamping: Int($0.rounded()))) }
        try set(summary.ascent) { try mesg.setTotalAscent(UInt16(clamping: Int($0.rounded()))) }
        try set(summary.descent) { try mesg.setTotalDescent(UInt16(clamping: Int($0.rounded()))) }
        try set(summary.averageAltitude) { try mesg.setEnhancedAvgAltitude($0) }
        try set(summary.averageGrade) { try mesg.setAvgGrade($0) }
        try set(summary.calories) { try mesg.setTotalCalories(UInt16(clamping: Int($0.rounded()))) }
        try set(summary.cycles) { try mesg.setTotalCycles(UInt32(clamping: Int($0.rounded()))) }
        try set(summary.averageVerticalOscillation) { try mesg.setAvgVerticalOscillation($0) }
        try set(summary.averageGroundContactTime) { try mesg.setAvgStanceTime($0) }
        try set(summary.averageStrideLength) { try mesg.setAvgStepLength($0) }
        try set(summary.averageRespirationRate) { try mesg.setAvgRespirationRate(UInt8(clamping: Int($0.rounded()))) }

        try set(summary.startPosition) {
            try mesg.setStartPositionLat(semicircles($0.latitude))
            try mesg.setStartPositionLong(semicircles($0.longitude))
        }
        try set(summary.endPosition) {
            try mesg.setEndPositionLat(semicircles($0.latitude))
            try mesg.setEndPositionLong(semicircles($0.longitude))
        }
    }

    /// Degrees to the 2^31-per-180 units FIT stores a position in.
    private static func semicircles(_ degrees: Double) -> Int32 {
        Int32(clamping: Int((degrees * (2_147_483_648.0 / 180.0)).rounded()))
    }
}

/// Runs the setter only where there is something to set. An absent FIT field means "not
/// recorded", and that is a different claim from zero.
private func set<Value>(_ value: Value?, _ apply: (Value) throws -> Void) rethrows {
    if let value { try apply(value) }
}

/// The summary setters `lap` and `session` share. Both SDK messages already have them all;
/// this only names them so one function can fill either.
private protocol SummarisedMesg: AnyObject {
    func setTotalDistance(_ value: Float64) throws
    func setAvgSpeed(_ value: Float64) throws
    func setMaxSpeed(_ value: Float64) throws
    func setEnhancedAvgSpeed(_ value: Float64) throws
    func setEnhancedMaxSpeed(_ value: Float64) throws
    func setAvgHeartRate(_ value: UInt8) throws
    func setMaxHeartRate(_ value: UInt8) throws
    func setMinHeartRate(_ value: UInt8) throws
    func setAvgCadence(_ value: UInt8) throws
    func setMaxCadence(_ value: UInt8) throws
    func setAvgPower(_ value: UInt16) throws
    func setMaxPower(_ value: UInt16) throws
    func setNormalizedPower(_ value: UInt16) throws
    func setTotalWork(_ value: UInt32) throws
    func setTotalAscent(_ value: UInt16) throws
    func setTotalDescent(_ value: UInt16) throws
    func setEnhancedAvgAltitude(_ value: Float64) throws
    func setAvgGrade(_ value: Float64) throws
    func setTotalCalories(_ value: UInt16) throws
    func setTotalCycles(_ value: UInt32) throws
    func setAvgVerticalOscillation(_ value: Float64) throws
    func setAvgStanceTime(_ value: Float64) throws
    func setAvgStepLength(_ value: Float64) throws
    func setAvgRespirationRate(_ value: UInt8) throws
    func setStartPositionLat(_ value: Int32) throws
    func setStartPositionLong(_ value: Int32) throws
    func setEndPositionLat(_ value: Int32) throws
    func setEndPositionLong(_ value: Int32) throws
}

extension LapMesg: SummarisedMesg {}
extension SessionMesg: SummarisedMesg {}
