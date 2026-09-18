// What the two background halves have been doing, for somebody asking why a session is not
// on the server. See docs/ios.md.

import SwiftUI
import UIKit

struct SyncLogView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [SyncLog.Entry] = []
    @State private var summary = SyncSummary()
    @State private var copied = false

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
                        "Newest first. A 💤 marks an event with nobody looking — only those "
                            + "say iOS ran the app on its own. Copy sends the whole log as text."
                    )
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Sync log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // The whole log rather than what is on screen: this is read by somebody
                    // who is not holding the phone, and a screenshot is three of these.
                    Button(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc") {
                        UIPasteboard.general.string = transcript
                        copied = true
                    }
                    .disabled(copied)
                }
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
        copied = false
    }

    /// The sheet as text, for pasting into a conversation about why a session is not there.
    /// Seconds are kept where the list rounds to the minute: what this is usually asked is
    /// the order of two things written moments apart.
    private var transcript: String {
        var lines = [
            "Sync log — \(Formats.moment(Date()))",
            "",
            "Health can wake the app: \(summary.delivery)",
            "Last background wake: \(summary.lastBackgroundWake)",
            "Uploaded on its own: \(summary.uploaded)",
            "",
            "Events, newest first (💤 = nobody looking)",
        ]
        lines += entries.map { entry in
            let asleep = entry.unattended ? " 💤" : ""
            return "\(Formats.precise(entry.at))  \(entry.kind.rawValue)  \(entry.said)\(asleep)"
        }
        if entries.isEmpty { lines.append("(nothing yet)") }
        return lines.joined(separator: "\n")
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
                    if entry.unattended { Image(systemName: "zzz") }
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
