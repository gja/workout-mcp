// One planned workout, step by step.
//
// The steps come from `GET /api/workout-plans` already resolved — one duration
// and up to two targets each, repeats kept — so this renders the plan rather than
// re-implementing the resolver that decides what it means. See docs/ios.md.

import SwiftUI

struct PlannedWorkoutView: View {
    let workout: PlannedWorkout

    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel

    @State private var plan: ResolvedPlan?
    @State private var failure: String?
    @State private var running = false

    /// The listing's copy, which an upload a moment ago may have moved on from.
    private var current: PlannedWorkout { model.current(workout) }

    var body: some View {
        List {
            Section {
                LabeledContent("Day", value: current.day.map(Formats.day) ?? current.date)
                LabeledContent("Sport", value: sport)
                let planned = Formats.summary(of: current.planned)
                if !planned.isEmpty {
                    LabeledContent("Planned", value: planned)
                }
                if let done = current.doneAt {
                    LabeledContent("Completed", value: Formats.moment(done))
                }
            }

            if let notes = current.notes, !notes.isEmpty {
                Section("Notes") { Text(notes).font(.callout) }
            }

            Section("Steps") {
                if let plan {
                    ForEach(PlanLine.of(plan.steps)) { line in
                        PlanLineRow(line: line)
                    }
                } else {
                    Text(failure ?? "Loading…").foregroundStyle(failure == nil ? Color.secondary : Color.red)
                }
            }

            // What it came to, for a workout opened from a session. No link back to that
            // session: this view is a step below it, not beside it.
            if let totals = current.stats?.session {
                Section("What you did") { Text(Formats.line(totals)).font(.callout) }
            }

            start
        }
        .listStyle(.insetGrouped)
        .navigationTitle(current.name)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: workout.key) { await load() }
        // On the list and not on the button that presents it: the button is inside a section
        // that is there only while the workout is not done, and an upload landing mid-run
        // would take the running screen down with it while HealthKit kept recording. Not
        // inside `ON_PHONE_RECORDING` as the button below is: a modifier is awkward to
        // compile out, and with no button to set `running` there is nothing to present.
        .fullScreenCover(isPresented: $running) {
            if #available(iOS 26.0, *), let plan {
                RunView(workout: current, steps: RunStep.of(plan.steps))
            }
        }
    }

    /// Below the plan rather than above it, and absent once the session is done: the button
    /// is what an athlete reaches for after reading the steps, and a workout already
    /// completed offers it again only to file a second session against the same day.
    @ViewBuilder
    private var start: some View {
        #if ON_PHONE_RECORDING
        if #available(iOS 26.0, *), Sports.isRecordable(current.sport), !current.isDone {
            Section {
                // A run is started against a plan, so the button waits for one: the screen
                // counts the intervals out of the steps above it and says what each is aimed
                // at, and it has neither until the plan has loaded.
                Button {
                    running = true
                } label: {
                    Label("Start on this iPhone", systemImage: "play.circle.fill")
                }
                .disabled(plan == nil)
            } footer: {
                Text("Recorded here and saved to Health, then sent up when you stop. Timed and measured intervals advance themselves and are called out; tap to get through an open one.")
            }
        }
        #endif
    }

    private var sport: String {
        current.subSport.map { "\(current.sport), \($0.replacingOccurrences(of: "_", with: " "))" } ?? current.sport
    }

    private func load() async {
        guard let client = session.client else { return }
        do {
            plan = try await client.plan(for: workout)
            failure = nil
        } catch {
            failure = error.localizedDescription
        }
    }
}

/// One line of a rendered plan: a step, or the header of a repeat block.
///
/// Flattened up front rather than rendered recursively, because a view that contains itself
/// is a type that contains itself, and the plan is only ever two levels deep anyway.
struct PlanLine: Identifiable {
    let id: Int
    let depth: Int
    let title: String
    let detail: String?
    let notes: String?
    let isRepeat: Bool

    static func of(_ steps: [ResolvedStep]) -> [PlanLine] {
        var lines: [PlanLine] = []
        walk(steps, depth: 0, into: &lines)
        return lines
    }

    private static func walk(_ steps: [ResolvedStep], depth: Int, into lines: inout [PlanLine]) {
        for step in steps {
            switch step {
            case .block(let times, let inner):
                lines.append(PlanLine(
                    id: lines.count, depth: depth, title: "\(times) ×",
                    detail: nil, notes: nil, isRepeat: true
                ))
                walk(inner, depth: depth + 1, into: &lines)

            case .effort(let effort):
                let targets = [effort.target, effort.secondaryTarget]
                    .compactMap { $0 }
                    .compactMap { Formats.describe($0) }
                lines.append(PlanLine(
                    id: lines.count,
                    depth: depth,
                    title: effort.name ?? effort.intensity.capitalized,
                    detail: [Formats.describe(effort.duration), targets.joined(separator: " + ")]
                        .filter { !$0.isEmpty }
                        .joined(separator: " @ "),
                    notes: effort.notes,
                    isRepeat: false
                ))
            }
        }
    }
}

private struct PlanLineRow: View {
    let line: PlanLine

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(line.title).font(line.isRepeat ? .subheadline.weight(.semibold) : .body)
                Spacer()
                if let detail = line.detail {
                    Text(detail).font(.callout).foregroundStyle(.secondary)
                }
            }
            if let notes = line.notes, !notes.isEmpty {
                Text(notes).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.leading, CGFloat(line.depth) * 16)
        .padding(.vertical, 1)
    }
}
