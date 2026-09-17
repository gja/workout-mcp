// What was actually done: every session there is evidence of, newest first.
//
// Two sources, one list. Health has what this phone recorded, which is what can still be
// uploaded; the server has what it has already read a file for, which is where the numbers
// come from. Most sessions are both, and the athlete should not have to know which.

import SwiftUI

struct ExecutedView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationStack {
            List {
                ProblemRow(problem: model.problem)

                Section {
                    if model.executed.isEmpty {
                        Text(model.loading ? "Loading…" : "No runs or rides in the last week.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.executed) { done in
                        NavigationLink(value: done) { ExecutedRow(done: done) }
                    }
                } header: {
                    Text("Last 7 days")
                } footer: {
                    Text("A tick means the server has read the file and worked out the numbers.")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Executed")
            .refreshable { await model.refresh(using: session.client) }
            .navigationDestination(for: ExecutedSession.self) { done in
                SessionView(done: done)
            }
        }
    }
}

private struct ExecutedRow: View {
    let done: ExecutedSession

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(done.sport).font(.headline)
                if done.isRecorded {
                    Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                }
            }
            Text(line).font(.caption).foregroundStyle(.secondary)
            if let workout = done.workout {
                Text(workout.name).font(.caption2).foregroundStyle(.tint)
            }
        }
        .padding(.vertical, 2)
    }

    /// The server's own figures where it has them, because they are the ones the rest of
    /// this tab is built on; what Health recorded where it does not.
    private var line: String {
        if let totals = done.workout?.stats?.session {
            return "\(Formats.moment(done.when)) · \(Formats.line(totals))"
        }
        if let activity = done.activity { return Formats.describe(activity) }
        return Formats.moment(done.when)
    }
}
