// One lap, in as much detail as there is.
//
// Which is a page of numbers and not a trace: the server reduces a recording to totals and
// four quarters a metric and keeps nothing else — no second-by-second heart rate, no GPS —
// so this is everything there is to show. The quarters are what make the averages
// trustworthy, because a rep that starts easy and decays averages out to a clean hit.
// See "Quarters" in docs/stats.md.

import SwiftUI

struct LapView: View {
    let lap: LapLine

    var body: some View {
        List {
            Section {
                LabeledContent("Step", value: lap.title)
                if let rep = lap.repNumber { LabeledContent("Rep", value: String(rep)) }
                if let seconds = lap.durationS { LabeledContent("Duration", value: Formats.clock(seconds)) }
                if let seconds = lap.movingS { LabeledContent("Moving", value: Formats.clock(seconds)) }
                if let metres = lap.distanceM { LabeledContent("Distance", value: Formats.distance(metres)) }
            } footer: {
                if lap.matchConfidence != "high" {
                    Text(confidence)
                }
            }

            if lap.avgHr != nil || lap.maxHr != nil || lap.minHr != nil {
                Section("Heart rate") {
                    if let hr = lap.avgHr { LabeledContent("Average", value: "\(Formats.whole(hr)) bpm") }
                    if let hr = lap.maxHr { LabeledContent("Max", value: "\(Formats.whole(hr)) bpm") }
                    if let hr = lap.minHr { LabeledContent("Min", value: "\(Formats.whole(hr)) bpm") }
                }
            }

            effort
            ground
            target
            quarters

            if !Formats.notes(lap.flags).isEmpty {
                Section("Worth knowing") {
                    ForEach(Formats.notes(lap.flags), id: \.self) { note in
                        Text(note).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Lap \(lap.index + 1)")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var confidence: String {
        switch lap.matchConfidence {
        case "low": return "Mapped on order, but this lap is off its step's length by more than half."
        default: return "This lap is matched to no planned step."
        }
    }

    @ViewBuilder private var effort: some View {
        if lap.avgPaceSKm != nil || lap.avgPowerW != nil || lap.avgCadence != nil {
            Section("Effort") {
                if let pace = lap.avgPaceSKm { LabeledContent("Pace", value: Formats.pace(pace)) }
                if let power = lap.avgPowerW { LabeledContent("Average power", value: "\(Formats.whole(power)) W") }
                if let power = lap.maxPowerW { LabeledContent("Max power", value: "\(Formats.whole(power)) W") }
                if let power = lap.normalizedPowerW {
                    LabeledContent("Normalized power", value: "\(Formats.whole(power)) W")
                }
                if let cadence = lap.avgCadence { LabeledContent("Cadence", value: "\(Formats.whole(cadence)) spm") }
            }
        }
    }

    /// The hill, beside the numbers it explains. A quarter slower than the one before it
    /// very often means the ground, and quarters read without it say *fade* — wrongly.
    @ViewBuilder private var ground: some View {
        if lap.elevGainM != nil || lap.elevNetM != nil {
            Section("Ground") {
                if let gain = lap.elevGainM { LabeledContent("Climbed", value: "\(Formats.whole(gain)) m") }
                if let loss = lap.elevLossM { LabeledContent("Descended", value: "\(Formats.whole(loss)) m") }
                if let net = lap.elevNetM { LabeledContent("Net", value: "\(Formats.whole(net)) m") }
                if let grade = lap.avgGradePct {
                    LabeledContent("Average grade", value: String(format: "%.1f%%", grade))
                }
            }
        }
    }

    @ViewBuilder private var target: some View {
        if let target = lap.target {
            Section {
                LabeledContent("Planned", value: Formats.band(target))
                if let did = Formats.actual(lap, on: target.metric) {
                    LabeledContent("Executed", value: did)
                }
                LabeledContent("In band", value: Formats.percent(target.pctTimeInBand))
                LabeledContent("Above", value: Formats.percent(target.pctTimeAbove))
                LabeledContent("Below", value: Formats.percent(target.pctTimeBelow))
            } header: {
                Text("Target")
            } footer: {
                Text("By moving time, over the whole recording rather than off the quarters.")
            }
        }
    }

    @ViewBuilder private var quarters: some View {
        if let quarters = lap.quarters {
            Section {
                QuartersGrid(quarters: quarters)
            } header: {
                Text("Quarters")
            } footer: {
                Text("Four equal segments of the lap, split by \(quarters.splitBy == "distance" ? "distance" : "time"). This is as close to the trace as it gets: the server keeps the quarters and not the second-by-second recording.")
            }
        }
    }
}

/// A metric across the four quarters, already formatted. Built up front so the grid is a
/// grid rather than six conditionals.
private struct QuarterLine: Identifiable {
    let label: String
    let values: [String]

    var id: String { label }
}

private struct QuartersGrid: View {
    let quarters: Quarters

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
            GridRow {
                Text("")
                ForEach(1 ... 4, id: \.self) { quarter in
                    Text("Q\(quarter)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
            ForEach(lines) { line in
                GridRow {
                    Text(line.label).font(.caption).foregroundStyle(.secondary)
                    ForEach(Array(line.values.enumerated()), id: \.offset) { _, value in
                        Text(value).font(.caption.monospacedDigit())
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }

    private var lines: [QuarterLine] {
        [
            line("HR", quarters.hr) { "\(Formats.whole($0))" },
            line("Pace", quarters.paceSKm) { Formats.clock($0) },
            line("Power", quarters.powerW) { "\(Formats.whole($0))" },
            line("Cadence", quarters.cadence) { "\(Formats.whole($0))" },
            line("Elev", quarters.elevNetM) { "\(Formats.whole($0))" },
            line("Grade", quarters.gradePct) { String(format: "%.1f", $0) },
        ]
        .compactMap { $0 }
    }

    /// Nothing recorded on a metric is a row left out, not a row of dashes.
    private func line(_ label: String, _ series: [Double?]?, _ format: (Double) -> String) -> QuarterLine? {
        guard let series, series.contains(where: { $0 != nil }) else { return nil }
        return QuarterLine(
            label: label,
            values: (0 ..< 4).map { index in
                index < series.count ? (series[index].map(format) ?? "—") : "—"
            }
        )
    }
}
