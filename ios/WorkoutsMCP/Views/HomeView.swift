// The home screen: the plan above, what the watch actually recorded below, and from either
// one tap to the thing you came to do.

import HealthKit
import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: AppSession
    @StateObject private var model = HomeModel()
    @State private var building: HKWorkout?

    var body: some View {
        NavigationStack {
            List {
                if let problem = model.problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
                plan
                recorded
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Workouts")
            .refreshable { await model.refresh(using: session.client) }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Sign out") { session.signOut() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Send all") {
                        Task { await model.sendEverythingToFitness(using: session.client) }
                    }
                    .disabled(model.loading)
                }
            }
            .task { await model.refresh(using: session.client) }
            .navigationDestination(item: $building) { activity in
                ActivityView(activity: activity, model: model)
            }
            .alert("Done", isPresented: Binding(
                get: { model.note != nil },
                set: { shown in if !shown { model.note = nil } }
            )) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(model.note ?? "")
            }
        }
    }

    // --- The plan --------------------------------------------------------------------

    @ViewBuilder private var plan: some View {
        Section("Planned") {
            if model.workouts.isEmpty {
                Text(model.loading ? "Loading…" : "Nothing planned in the next fortnight.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.workouts) { workout in
                PlannedRow(workout: workout, onWatch: model.scheduled.contains(workout.key))
                    .swipeActions(edge: .trailing) {
                        if model.scheduled.contains(workout.key) {
                            Button("Remove", role: .destructive) {
                                Task { await model.removeFromFitness(workout) }
                            }
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button("To Fitness") {
                            Task { await model.sendToFitness(workout, using: session.client) }
                        }
                        .tint(.green)
                    }
            }
        }
    }

    // --- What was actually run ---------------------------------------------------------

    @ViewBuilder private var recorded: some View {
        Section("Recorded in Health") {
            if model.activities.isEmpty {
                Text("No runs or rides in the last week.").foregroundStyle(.secondary)
            }
            ForEach(model.activities, id: \.uuid) { activity in
                Button {
                    building = activity
                } label: {
                    ActivityRow(activity: activity, matched: model.suggestion(for: activity))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

private struct PlannedRow: View {
    let workout: PlannedWorkout
    let onWatch: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(workout.name).font(.headline)
                Spacer()
                if workout.isDone {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                } else if onWatch {
                    Image(systemName: "applewatch").foregroundStyle(.secondary)
                }
            }
            Text([workout.date, workout.sport].joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let summary = workout.summary {
                Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

private struct ActivityRow: View {
    let activity: HKWorkout
    let matched: PlannedWorkout?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(HealthAccess.sport(of: activity) == .cycling ? "Ride" : "Run").font(.headline)
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            Text(Formats.describe(activity)).font(.caption).foregroundStyle(.secondary)
            if let matched {
                Text("Looks like \(matched.name)").font(.caption2).foregroundStyle(.tint)
            }
        }
        .padding(.vertical, 2)
    }
}

enum Formats {
    static func describe(_ activity: HKWorkout) -> String {
        var parts = [activity.startDate.formatted(date: .abbreviated, time: .shortened)]
        parts.append(duration(activity.duration))
        if let metres = HealthAccess.distance(of: activity), metres > 0 {
            parts.append(String(format: "%.2f km", metres / 1000))
        }
        return parts.joined(separator: " · ")
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded())
        return whole >= 3600
            ? String(format: "%d:%02d:%02d", whole / 3600, (whole % 3600) / 60, whole % 60)
            : String(format: "%d:%02d", whole / 60, whole % 60)
    }
}
