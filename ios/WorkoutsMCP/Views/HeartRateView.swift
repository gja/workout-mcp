// The two figures heart rate zones are built from, off a year of Health, for an athlete the
// setup wizard has just asked for them. See docs/ios.md.
//
// The bands themselves are not here. They live in `workout-zones` on the server, which is
// the single source of truth for physiology — a second set of zones computed on the phone
// would be a second answer to the same question. This screen is the measurements, and a
// button that hands them over in the words an assistant can act on.

import SwiftUI
import UIKit

struct HeartRateView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var summary: HeartRateSummary?
    @State private var failure: String?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                if let summary {
                    if summary.isEmpty {
                        Section { Text(Self.nothing).foregroundStyle(.secondary) }
                    } else {
                        restingSection(summary)
                        maxSection(summary)
                        handoverSection(summary)
                    }
                } else if let failure {
                    Section { Text(failure).foregroundStyle(.red) }
                } else {
                    Section {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Reading a year of Health…").foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Heart rate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
        }
    }

    // --- The two numbers ------------------------------------------------------------------

    @ViewBuilder private func restingSection(_ summary: HeartRateSummary) -> some View {
        Section {
            if let average = summary.restingAverage {
                LabeledContent("Average", value: "\(Formats.whole(average)) bpm")
                if let recent = summary.restingRecent {
                    LabeledContent("Last \(HeartRateSummary.recentDays) days", value: "\(Formats.whole(recent)) bpm")
                }
                LabeledContent("Days recorded", value: "\(summary.resting.count)")
            } else {
                Text("Health has no resting heart rate.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Resting heart rate")
        } footer: {
            Text(
                "A watch writes one resting figure a day, from the quiet parts of it. The "
                    + "average is of the days it wrote one; the recent line is there because a "
                    + "resting heart rate that has moved is what a year-long average hides."
            )
        }
    }

    @ViewBuilder private func maxSection(_ summary: HeartRateSummary) -> some View {
        Section {
            if let observed = summary.observedMax {
                LabeledContent("Observed max", value: "\(Formats.whole(observed.bpm)) bpm")
                ForEach(summary.topDays) { day in
                    LabeledContent("\(Formats.whole(day.bpm)) bpm", value: Formats.day(day.day))
                        .foregroundStyle(.secondary)
                        .font(.footnote)
                }
            } else {
                Text("Health has no heart rate recorded.").foregroundStyle(.secondary)
            }
        } header: {
            Text("Max heart rate")
        } footer: {
            Text(
                "The \(HeartRateSummary.agreeingOrdinal) highest day of the last \(summary.days) days, "
                    + "not the highest: a wrist sensor spikes, and one reading with nothing near "
                    + "it in any other day is an artefact rather than a maximum. Days, not "
                    + "sessions, so an all-out effort that was never started as a workout still "
                    + "counts. It is a floor — a true maximum needs an effort hard enough to find it."
            )
        }
    }

    // --- And what to do with them -----------------------------------------------------------

    @ViewBuilder private func handoverSection(_ summary: HeartRateSummary) -> some View {
        Section {
            if let reserve = summary.reserve {
                LabeledContent("Heart rate reserve", value: "\(Formats.whole(reserve)) bpm")
            }
            Button(copied ? "Copied" : "Copy for your assistant") { copy(summary) }
        } footer: {
            Text(
                "Reserve is max minus resting — what a Karvonen percentage is taken of. Paste "
                    + "the rest into the assistant setting your training up: it writes the bands "
                    + "into your workout zones, which is where every target is anchored."
            )
        }
    }

    /// Prose rather than a table, and it says where the numbers came from: an assistant
    /// handed a bare 186 has no way to tell a measurement from a guess.
    private func copy(_ summary: HeartRateSummary) {
        var lines = ["Heart rate from Apple Health, the last \(summary.days) days to \(Formats.dated(Date())):"]

        if let average = summary.restingAverage {
            var resting = "- Resting: \(Formats.whole(average)) bpm averaged over "
                + "\(summary.resting.count) days"
            if let recent = summary.restingRecent {
                resting += ", \(Formats.whole(recent)) bpm over the last \(HeartRateSummary.recentDays)"
            }
            lines.append(resting + ".")
        }

        if let observed = summary.observedMax {
            let days = summary.topDays
                .map { "\(Formats.whole($0.bpm)) bpm (\(Formats.dated($0.day)))" }
                .joined(separator: ", ")
            lines.append(
                "- Max: \(Formats.whole(observed.bpm)) bpm observed — the "
                    + "\(HeartRateSummary.agreeingOrdinal) highest day, so a single sensor spike cannot "
                    + "set it. The highest days were \(days)."
            )
        }

        if let reserve = summary.reserve {
            lines.append("- Heart rate reserve: \(Formats.whole(reserve)) bpm.")
        }

        lines.append(
            "These are wrist figures read off Health, not a test. The max is a floor: it is the "
                + "hardest this athlete has been recorded working, not the hardest they can work."
        )

        UIPasteboard.general.string = lines.joined(separator: "\n")
        copied = true
    }

    private static let nothing =
        "Health has no heart rate for the last year — or has not been allowed to share it, "
            + "which is Settings › Health › Data Access & Devices › WorkoutsMCP."

    private func load() async {
        do {
            summary = try await HeartRateReader.summary()
        } catch {
            failure = error.localizedDescription
        }
    }
}
