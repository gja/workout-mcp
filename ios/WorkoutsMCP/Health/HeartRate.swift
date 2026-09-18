// A year of Health in the two figures a heart rate zone is anchored to: what this athlete
// rests at, and what they have actually reached. See docs/ios.md.

import Foundation
import HealthKit

/// One day and one figure. The **day** rather than the session: HealthKit has no predicate
/// for "any workout", so a per-session maximum would be one query per session.
struct HeartRateDay: Identifiable, Hashable {
    let day: Date
    let bpm: Double

    var id: Date { day }
}

/// The window reduced to the numbers, with enough of the working out left in to see where
/// each came from. Nothing here is rounded: the view says how it wants to read them.
struct HeartRateSummary {
    let days: Int
    /// Every day Health wrote a resting figure, oldest first.
    let resting: [HeartRateDay]
    /// Every day with a heart rate at all, highest first.
    let peaks: [HeartRateDay]

    /// How many days have to reach a figure before it is taken as a maximum rather than a
    /// spike. The interview in `src/getting-started.md` asks an athlete for the same thing:
    /// two or three hard sessions agreeing, not the single highest number on the watch.
    static let agreeing = 3

    /// "3rd", spelled from the constant, so the prose on the screen cannot claim a rule the
    /// numbers do not follow.
    static let agreeingOrdinal: String = {
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        return formatter.string(from: NSNumber(value: agreeing)) ?? "\(agreeing)"
    }()

    /// A recent average as well as the year's, because a resting heart rate that has moved
    /// is the one fact a single year-long average hides.
    static let recentDays = 30

    var isEmpty: Bool { resting.isEmpty && peaks.isEmpty }

    var restingAverage: Double? { mean(resting.map(\.bpm)) }

    var restingRecent: Double? {
        let since = Calendar.current.date(byAdding: .day, value: -Self.recentDays, to: Date()) ?? Date()
        return mean(resting.filter { $0.day >= since }.map(\.bpm))
    }

    /// The lowest of the top `agreeing` days, and the figure this screen means by a maximum:
    /// a wrist sensor spikes, and a lone 205 with nothing near it is an artefact rather than
    /// a measurement. It is a floor — a true maximum needs an effort hard enough to find it.
    /// A year with fewer days than that in it falls back to the lowest day there is.
    var observedMax: HeartRateDay? {
        peaks.isEmpty ? nil : peaks[min(Self.agreeing - 1, peaks.count - 1)]
    }

    /// What the top of the range rests on, so the athlete can see the three days it is read off.
    var topDays: [HeartRateDay] { Array(peaks.prefix(Self.agreeing)) }

    /// Max minus resting: what a Karvonen percentage is taken of. Nil unless both are there,
    /// because half of it is not a reserve.
    var reserve: Double? {
        guard let max = observedMax?.bpm, let resting = restingAverage else { return nil }
        return max - resting
    }

    private func mean(_ values: [Double]) -> Double? {
        values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)
    }
}

enum HeartRateReader {
    /// A year. Long enough to hold a hard season whenever it fell, short enough that last
    /// year's fitness is not what the zones come out of.
    static let window = 365

    private static let bpm = HKUnit.count().unitDivided(by: .minute())

    /// Two queries for a year, whatever the athlete recorded in it. Read rather than
    /// listened to: this is a screen somebody opened, not a figure the app keeps.
    static func summary(days: Int = window) async throws -> HeartRateSummary {
        try await HealthAccess.request()
        let since = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()

        async let restingDays = daily(HKQuantityType(.restingHeartRate), .discreteAverage, since: since)
        async let peakDays = daily(HKQuantityType(.heartRate), .discreteMax, since: since)

        let resting = try await restingDays
        let peaks = try await peakDays
        return HeartRateSummary(days: days, resting: resting, peaks: peaks.sorted { $0.bpm > $1.bpm })
    }

    /// One statistics query bucketed by day, rather than the samples themselves: a year of
    /// heart rate is a million samples on a watch that is worn, and the day is the grain
    /// everything above reads at anyway. A day Health has nothing for is absent, not zero.
    private static func daily(
        _ type: HKQuantityType,
        _ options: HKStatisticsOptions,
        since: Date
    ) async throws -> [HeartRateDay] {
        let range = HKQuery.predicateForSamples(withStart: since, end: nil, options: .strictStartDate)
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: range),
            options: options,
            anchorDate: Calendar.current.startOfDay(for: since),
            intervalComponents: DateComponents(day: 1)
        )

        return try await descriptor.result(for: HealthAccess.store).statistics().compactMap { day in
            let quantity = options.contains(.discreteMax) ? day.maximumQuantity() : day.averageQuantity()
            return quantity.map { HeartRateDay(day: day.startDate, bpm: $0.doubleValue(for: bpm)) }
        }
    }
}
