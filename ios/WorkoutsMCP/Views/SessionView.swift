// One session, in full: what the watch recorded, what the server made of it, and the
// planned workout it was run against.
//
// Every number below the file itself is the server's. It read the file once, reduced it to
// totals, laps and quarters, and threw the bytes away; this view asks for that document
// rather than computing a second set of answers off HealthKit. See docs/stats.md.

import HealthKit
import SwiftUI

struct SessionView: View {
    let done: ExecutedSession

    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel

    @State private var stats: WorkoutStats?
    @State private var fit: URL?
    @State private var building = false
    @State private var failure: String?

    /// The listing's copy of the planned workout, so an upload a moment ago is reflected here.
    private var workout: PlannedWorkout? { done.workout.map { model.current($0) } }

    var body: some View {
        List {
            recorded
            planned
            totals
            laps
            upload

            if let failure {
                Section { Text(failure).foregroundStyle(.red) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(done.sport)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: workout?.stats?.computedAt) { await loadStats() }
    }

    // --- What the phone has -----------------------------------------------------------

    @ViewBuilder private var recorded: some View {
        if let activity = done.activity {
            Section("Recorded") {
                LabeledContent("Started", value: Formats.moment(activity.startDate))
                LabeledContent("Duration", value: Formats.clock(activity.duration))
                if let metres = HealthAccess.distance(of: activity), metres > 0 {
                    LabeledContent("Distance", value: Formats.distance(metres))
                }
            }
        }
    }

    /// Which workout this was — a fact, not a field. The match comes from the plan id the
    /// watch recorded, or from the one workout of that sport planned for that day; a session
    /// that is neither is not a session this app should be inviting a guess about.
    @ViewBuilder private var planned: some View {
        Section {
            if let workout {
                NavigationLink { PlannedWorkoutView(workout: workout) } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(workout.name).font(.headline)
                        Text([workout.day.map(Formats.day) ?? workout.date, Formats.summary(of: workout.planned)]
                            .filter { !$0.isEmpty }
                            .joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Text("Not matched to a planned workout")
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("This was")
        } footer: {
            if workout == nil {
                Text("The watch did not name a plan, and more than one workout — or none — was planned for that day. There is nothing to upload it against.")
            }
        }
    }

    // --- What the server made of it ---------------------------------------------------

    @ViewBuilder private var totals: some View {
        if let totals = workout?.stats?.session {
            Section("What you did") {
                if let seconds = totals.movingS { LabeledContent("Moving", value: Formats.clock(seconds)) }
                if let seconds = totals.elapsedS { LabeledContent("Elapsed", value: Formats.clock(seconds)) }
                if let metres = totals.distanceM { LabeledContent("Distance", value: Formats.distance(metres)) }
                if let pace = totals.avgPaceSKm { LabeledContent("Pace", value: Formats.pace(pace)) }
                if let hr = totals.avgHr { LabeledContent("Average heart rate", value: "\(Formats.whole(hr)) bpm") }
                if let hr = totals.maxHr { LabeledContent("Max heart rate", value: "\(Formats.whole(hr)) bpm") }
                if let hr = totals.minHr { LabeledContent("Min heart rate", value: "\(Formats.whole(hr)) bpm") }
                if let power = totals.avgPowerW { LabeledContent("Average power", value: "\(Formats.whole(power)) W") }
                if let power = totals.normalizedPowerW { LabeledContent("Normalized power", value: "\(Formats.whole(power)) W") }
                if let cadence = totals.avgCadence { LabeledContent("Cadence", value: "\(Formats.whole(cadence)) spm") }
                if let gain = totals.totalAscentM { LabeledContent("Ascent", value: "\(Formats.whole(gain)) m") }
                if let calories = totals.calories { LabeledContent("Calories", value: "\(Formats.whole(calories)) kcal") }
            }
        }

        if let summary = workout?.stats, !Formats.notes(summary.flags).isEmpty || summary.error != nil {
            Section("Worth knowing") {
                ForEach(Formats.notes(summary.flags), id: \.self) { note in
                    Text(note).font(.callout).foregroundStyle(.secondary)
                }
                // The reason behind `source_unreadable`, which is the one flag that says
                // nothing on its own.
                if let why = summary.error {
                    Text(why).font(.callout).foregroundStyle(.secondary)
                }
            }
        }

        if let comment = workout?.comment, !comment.isEmpty {
            Section("Your note") { Text(comment).font(.callout) }
        }
    }

    /// A lap a row, the band it was aimed at beside what it did on that same metric. The
    /// laps are their own read, so this is the one thing on the screen that waits.
    @ViewBuilder private var laps: some View {
        if let stats, !stats.laps.isEmpty {
            Section {
                ForEach(stats.laps) { lap in
                    NavigationLink { LapView(lap: lap) } label: { LapRow(lap: lap) }
                }
            } header: {
                Text("Laps")
            } footer: {
                if !stats.isMatchedToPlan {
                    Text("These laps are not matched to the plan's steps, so nothing here is compared against a target.")
                }
            }
        }
    }

    // --- Back to the server -----------------------------------------------------------

    @ViewBuilder private var upload: some View {
        if let activity = done.activity {
            Section {
                Button(building ? "Building…" : "Generate .fit") {
                    Task { await build(activity) }
                }
                .disabled(building)

                if let fit {
                    ShareLink(item: fit) { Label("Share \(fit.lastPathComponent)", systemImage: "square.and.arrow.up") }

                    Button(workout?.isDone == true ? "Upload again" : "Upload to WorkoutsMCP") {
                        guard let workout else { return }
                        Task { await model.upload(fit, from: activity, to: workout, using: session.client) }
                    }
                    .disabled(workout == nil || model.loading)
                }
            } footer: {
                Text("The server ingests the file, works out the stats and marks the session done; it does not keep the file.")
            }
        }
    }

    // --- Loading ----------------------------------------------------------------------

    private func loadStats() async {
        guard let workout, workout.stats?.session != nil, let client = session.client else { return }
        stats = try? await client.stats(for: workout)
    }

    private func build(_ activity: HKWorkout) async {
        building = true
        defer { building = false }

        do {
            fit = try await model.buildFit(for: activity, matching: workout)
            failure = nil
        } catch {
            failure = error.localizedDescription
            fit = nil
        }
    }
}

/// One lap: what it was for, how long it ran, and the band against what it did.
private struct LapRow: View {
    let lap: LapLine

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text("\(lap.index + 1). \(lap.title)").font(.subheadline.weight(.medium))
                Spacer()
                Text(Formats.length(lap)).font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Text(plan).font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(actual).font(.caption).foregroundStyle(inBand ? Color.green : Color.primary)
            }
        }
        .padding(.vertical, 2)
    }

    /// What this lap was meant to be: which rep it is, and the band it was given. A lap the
    /// plan has no step for says so — it is real training with nowhere to go, not a failure.
    private var plan: String {
        [
            lap.repNumber.map { "Rep \($0)" },
            lap.target.map { "Planned \(Formats.band($0))" },
            lap.matchConfidence == "unmatched" ? "No planned step" : nil,
        ]
        .compactMap { $0 }
        .joined(separator: " · ")
    }

    private var actual: String {
        guard let target = lap.target else { return Formats.headline(lap) ?? "—" }
        let did = Formats.actual(lap, on: target.metric) ?? "—"
        return "\(did) · \(Formats.percent(target.pctTimeInBand)) in band"
    }

    /// Green only where most of the lap was inside the band it was given. The dashboard
    /// draws the same line at the same place.
    private var inBand: Bool { (lap.target?.pctTimeInBand ?? 0) >= 0.8 }
}
