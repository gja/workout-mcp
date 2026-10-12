// What is coming: the plan the server holds, as a calendar like the dashboard's, and the
// day picked on it underneath.
//
// The watch is where these are followed — this tab is not a second copy to keep honest,
// it is the answer to "what is it today, and what is it on Saturday".

import SwiftUI

struct PlannedView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel
    @State private var selected = Calendar.current.startOfDay(for: Date())
    @State private var showingQuickAdd = false
    @State private var deleting: PlannedWorkout?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SyncRow(phase: model.sync) { Task { await model.syncToAppleFitness(using: session.client) } }
                }

                ProblemRow(problem: model.problem)

                Section {
                    PlanCalendar(days: model.calendarDays, workouts: model.workouts, selected: $selected)
                }

                Section(dayTitle) {
                    let workouts = model.workouts(on: selected)
                    if workouts.isEmpty {
                        Text(model.loading ? "Loading…" : "Nothing planned.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(workouts) { workout in
                        NavigationLink(value: workout) { PlannedRow(workout: workout) }
                            .swipeActions {
                                Button("Delete", role: .destructive) { deleting = workout }
                            }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Planned")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingQuickAdd = true } label: { Label("Quick add", systemImage: "plus") }
                }
            }
            .refreshable { await model.refreshAndSyncIfStale(using: session.client) }
            .deleteConfirmation(for: $deleting) { workout in
                await model.delete(workout, using: session.client)
            }
            .navigationDestination(for: PlannedWorkout.self) { workout in
                PlannedWorkoutView(workout: workout)
            }
            .sheet(isPresented: $showingQuickAdd) {
                let days = model.loadedDays
                // The calendar draws whole weeks, so the day picked can sit just outside what is loaded.
                QuickAddView(date: min(max(selected, days.lowerBound), days.upperBound), days: days) { day in
                    selected = Calendar.current.startOfDay(for: day)
                    await model.planDidChange(using: session.client)
                }
            }
        }
    }

    private var dayTitle: String {
        let day = Formats.day(selected)
        return Calendar.current.isDateInToday(selected) ? "Today · \(day)" : day
    }
}

extension View {
    /// Asked first, because a delete takes a recorded session's numbers with it and there is
    /// no undo. Shared by the swipe on the Planned tab and the button on a workout's own screen.
    func deleteConfirmation(
        for workout: Binding<PlannedWorkout?>,
        perform: @escaping (PlannedWorkout) async -> Void
    ) -> some View {
        confirmationDialog(
            workout.wrappedValue.map { "Delete \($0.name)?" } ?? "",
            isPresented: Binding(get: { workout.wrappedValue != nil }, set: { if !$0 { workout.wrappedValue = nil } }),
            titleVisibility: .visible,
            presenting: workout.wrappedValue
        ) { target in
            Button("Delete", role: .destructive) { Task { await perform(target) } }
        } message: { target in
            Text(target.isDone
                ? "It is gone from the plan and the watch, and the session recorded against it with it."
                : "It is gone from the plan and the watch.")
        }
    }
}

struct PlannedRow: View {
    let workout: PlannedWorkout

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("\(Sports.icon(workout.sport)) \(workout.name)").font(.headline)
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var detail: String {
        [
            workout.isDone ? "Done" : "",
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
