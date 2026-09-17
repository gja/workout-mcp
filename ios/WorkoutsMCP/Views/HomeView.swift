// The home screen: where the plan stands with Apple Fitness, what the watch recorded in the
// last week, and the way out.

import HealthKit
import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var session: AppSession
    @StateObject private var model = HomeModel()
    @State private var building: HKWorkout?

    var body: some View {
        NavigationStack {
            List {
                Section { SyncRow(phase: model.sync) { Task { await model.syncToAppleFitness(using: session.client) } } }

                if let problem = model.problem {
                    Section { Text(problem).foregroundStyle(.red).font(.callout) }
                }

                recorded

                Section {
                    Button("Log out", role: .destructive) { session.signOut() }
                        .frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Workouts")
            .refreshable {
                await model.refresh(using: session.client)
                await model.syncToAppleFitness(using: session.client)
            }
            .task { await model.refreshAndSyncIfStale(using: session.client) }
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

    @ViewBuilder private var recorded: some View {
        Section("Last 7 days") {
            if model.activities.isEmpty {
                Text(model.loading ? "Loading…" : "No runs or rides in the last week.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.activities, id: \.uuid) { activity in
                Button {
                    building = activity
                } label: {
                    ActivityRow(
                        activity: activity,
                        matched: model.suggestion(for: activity),
                        uploaded: model.isUploaded(activity)
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// The one line the home screen exists for: is the plan on the watch, and when did it get
/// there. The whole row is the button, because "tap to resync" should mean tapping it.
private struct SyncRow: View {
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

    /// `Text(_:style: .relative)` keeps counting on its own, so "2 min ago" stays true
    /// without the view being told to redraw.
    @ViewBuilder private var detail: some View {
        switch phase {
        case .never:
            Text("Tap to send your planned workouts to your watch")
        case .syncing(let done, let total):
            Text(total > 0 ? "\(done) of \(total)" : "Checking your plan")
        case .synced(let at, let count):
            Text("\(count) planned workout\(count == 1 ? "" : "s") · ") + Text(at, style: .relative) + Text(" ago · Tap to resync")
        case .failed(let why):
            Text("\(why) · Tap to try again")
        }
    }
}

private struct ActivityRow: View {
    let activity: HKWorkout
    let matched: PlannedWorkout?
    let uploaded: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(HealthAccess.isRide(activity) ? "Ride" : "Run").font(.headline)
                if uploaded {
                    Image(systemName: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            Text(Formats.describe(activity)).font(.caption).foregroundStyle(.secondary)
            if let matched {
                Text(matched.name).font(.caption2).foregroundStyle(.tint)
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
