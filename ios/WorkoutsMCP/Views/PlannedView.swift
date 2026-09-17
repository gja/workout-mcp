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

                Section("Next 14 days") {
                    if model.upcoming.isEmpty {
                        Text(model.loading ? "Loading…" : "Nothing planned.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.upcoming) { workout in
                        NavigationLink(value: workout) { PlannedRow(workout: workout) }
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
