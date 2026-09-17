// What is coming: the plan the server holds, in the order it will be run.
//
// The watch is where these are followed — this tab is not a second copy to keep honest,
// it is the answer to "what is it today, and what is it on Saturday".

import SwiftUI

struct PlannedView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SyncRow(phase: model.sync) { Task { await model.syncToAppleFitness(using: session.client) } }
                } footer: {
                    Text("Two days back to seven days ahead, minus anything already done. Anything this app put on the watch outside that window comes off again.")
                }

                ProblemRow(problem: model.problem)

                if !model.missed.isEmpty {
                    Section {
                        ForEach(model.missed) { workout in
                            NavigationLink(value: workout) { PlannedRow(workout: workout) }
                        }
                    } header: {
                        Text("Missed")
                    } footer: {
                        Text("Still on the watch: a sync reaches two days back, so a session missed on Sunday is there to do on Tuesday.")
                    }
                }

                if model.upcoming.isEmpty {
                    Section("This week") {
                        Text(model.loading ? "Loading…" : "Nothing planned.")
                            .foregroundStyle(.secondary)
                    }
                }

                ForEach(model.plannedWeeks) { week in
                    Section(week.title) {
                        ForEach(week.workouts) { workout in
                            NavigationLink(value: workout) { PlannedRow(workout: workout) }
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Planned")
            .refreshable { await model.refresh(using: session.client) }
            .navigationDestination(for: PlannedWorkout.self) { workout in
                PlannedWorkoutView(workout: workout)
            }
        }
    }
}

struct PlannedRow: View {
    let workout: PlannedWorkout

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(workout.name).font(.headline)
            Text(dateLine).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var dateLine: String {
        [
            workout.day.map(Formats.day) ?? workout.date,
            workout.sport,
            Formats.summary(of: workout.planned),
        ]
        .filter { !$0.isEmpty }
        .joined(separator: " · ")
    }
}

/// The one line above the plan: is it on the watch, and when did it get there. It sits here
/// rather than in Settings because it is a fact about the plan underneath it, read in the
/// same glance. The whole row is the button, because "tap to resync" should mean tapping it.
struct SyncRow: View {
    let phase: SyncPhase
    let resync: () -> Void

    var body: some View {
        Button(action: resync) {
            HStack(spacing: 12) {
                icon
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.headline)
                    detail.font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .disabled(isSyncing)
    }

    private var isSyncing: Bool {
        if case .syncing = phase { return true }
        return false
    }

    @ViewBuilder private var icon: some View {
        switch phase {
        case .syncing:
            ProgressView().frame(width: 28)
        case .synced:
            Image(systemName: "checkmark.circle.fill").font(.title2).foregroundStyle(.green).frame(width: 28)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill").font(.title2).foregroundStyle(.orange).frame(width: 28)
        case .never:
            Image(systemName: "applewatch").font(.title2).foregroundStyle(.secondary).frame(width: 28)
        }
    }

    private var title: String {
        switch phase {
        case .never: return "Not in Apple Fitness yet"
        case .syncing: return "Syncing to Apple Fitness…"
        case .synced: return "Synced to Apple Fitness"
        case .failed: return "Could not sync to Apple Fitness"
        }
    }

    @ViewBuilder private var detail: some View {
        switch phase {
        case .never:
            Text("Tap to send your planned workouts to your watch")
        case .syncing(let done, let total):
            Text(total > 0 ? "\(done) of \(total)" : "Checking your plan")
        case .synced(let at, let count):
            // Redrawn on the minute, because nothing else on this row changes when time
            // passes and the line would otherwise still say "just now" an hour later.
            TimelineView(.periodic(from: at, by: 60)) { tick in
                Text("\(count) planned workout\(count == 1 ? "" : "s") · "
                    + "\(Formats.since(at, now: tick.date)) · Tap to resync")
            }
        case .failed(let why):
            Text("\(why) · Tap to try again")
        }
    }
}
