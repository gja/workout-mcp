// What the two background halves have been doing, for somebody asking why a session is not
// on the server. See docs/ios.md.

import SwiftUI

struct SyncLogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [SyncLog.Entry] = []
    @State private var summary = SyncSummary()

    var body: some View {
        NavigationStack {
            List {
                Section("Where it stands") {
                    LabeledContent("Health can wake the app", value: summary.delivery)
                    LabeledContent("Last background wake", value: summary.lastBackgroundWake)
                    LabeledContent("Uploaded on its own", value: summary.uploaded)
                }

                Section {
                    if entries.isEmpty {
                        Text("Nothing yet.").foregroundStyle(.secondary)
                    }
                    ForEach(entries) { entry in
                        EventRow(entry: entry)
                    }
                } header: {
                    Text("Events")
                } footer: {
                    Text(
                        "Newest first. A moon marks an event with nobody looking — only those "
                            + "say iOS ran the app on its own, since opening it fires the observer too."
                    )
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Sync log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .refreshable { load() }
            .onAppear(perform: load)
        }
    }

    private func load() {
        entries = SyncLog.entries.reversed()
        summary = SyncSummary()
    }
}

private struct EventRow: View {
    let entry: SyncLog.Entry

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: symbol)
                .foregroundStyle(.secondary)
                .frame(width: 18)

            VStack(alignment: .leading, spacing: 2) {
                Text(entry.said)
                HStack(spacing: 6) {
                    Text(Formats.moment(entry.at))
                    // The whole point of the log: an event nobody was watching.
                    if entry.unattended { Image(systemName: "moon.fill") }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private var symbol: String {
        switch entry.kind {
        case .delivery: return "bell"
        case .wake: return "bolt"
        case .upload: return "arrow.up.circle"
        case .plan: return "calendar"
        }
    }
}

/// One reading of the counters, so the three lines are three facts from the same moment.
private struct SyncSummary {
    let delivery: String
    let lastBackgroundWake: String
    let uploaded: String

    init() {
        // A problem here explains every other silence: nothing downstream of it ever runs.
        if let asked = SyncLog.delivery {
            delivery = asked.problem ?? "yes"
        } else {
            delivery = "not asked yet"
        }

        if let wake = SyncLog.lastBackgroundWake {
            let count = SyncLog.backgroundWakes
            let when = "\(Formats.since(wake.at)) — \(wake.said)"
            lastBackgroundWake = count > 1 ? "\(when) · \(count) in all" : when
        } else {
            lastBackgroundWake = "never"
        }

        uploaded = "\(SyncLog.uploadedOnItsOwn)"
    }
}
