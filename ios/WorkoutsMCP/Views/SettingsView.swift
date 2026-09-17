// Everything that is neither the plan nor a session: where the plan stands with Apple
// Fitness, who is signed in, and the way out.

import SwiftUI

struct SettingsView: View {
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

                Section("Account") {
                    if let email = session.account?.email {
                        LabeledContent("Signed in as", value: email)
                    }
                    LabeledContent("Server", value: AppServer.host)
                }

                Section {
                    Button("Log out", role: .destructive) { session.signOut() }
                        .frame(maxWidth: .infinity)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Settings")
            .task { await session.loadAccount() }
        }
    }
}

/// The one line this tab exists for: is the plan on the watch, and when did it get there.
/// The whole row is the button, because "tap to resync" should mean tapping it.
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
            // Redrawn on the minute, because nothing else on this screen changes when time
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
