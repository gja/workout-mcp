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
                    LabeledContent("Background App Refresh", value: allowed.refresh)
                    LabeledContent("Low Power Mode", value: allowed.lowPower)
                    LabeledContent("Last background wake", value: summary.lastBackgroundWake)
                    LabeledContent("Last refresh turn", value: summary.refreshTurn)
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

    /// The phone's own two switches, read at the moment the sheet is rather than kept with the
    /// counters: nothing this app records can see them, and either one off is the answer to
    /// every other line here. HealthKit goes on saying it will wake an app that Background App
    /// Refresh will not let iOS run.
    @MainActor
    private var allowed: (refresh: String, lowPower: String) {
        let refresh: String
        switch SyncLog.backgroundRefresh {
        case .available: refresh = "on"
        case .denied: refresh = "off — Settings › General › Background App Refresh"
        case .restricted: refresh = "not allowed on this phone"
        @unknown default: refresh = "unknown"
        }
        return (refresh, SyncLog.lowPowerMode ? "on — background work is held back" : "off")
    }

    /// The sheet as text, for pasting into a conversation about why a session is not there.
    /// Seconds are kept where the list rounds to the minute: what this is usually asked is
    /// the order of two things written moments apart.
    @MainActor
    private var transcript: String {
        var lines = [
            "Sync log — \(Formats.moment(Date()))",
            "",
            "Health can wake the app: \(summary.delivery)",
            "Background App Refresh: \(allowed.refresh)",
            "Low Power Mode: \(allowed.lowPower)",
            "Last background wake: \(summary.lastBackgroundWake)",
            "Last refresh turn: \(summary.refreshTurn)",
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

/// One reading of the counters, so the lines are facts from the same moment.
private struct SyncSummary {
    let delivery: String
    let lastBackgroundWake: String
    let refreshTurn: String
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

        // The backstop, which is the other thing that should be running with nobody looking.
        // A problem first: a turn iOS will not schedule is why there has not been one.
        let refresh = SyncLog.refresh
        if let problem = refresh.problem {
            refreshTurn = problem
        } else if let at = refresh.at {
            refreshTurn = Formats.since(at)
        } else {
            refreshTurn = "not yet"
        }

        uploaded = "\(SyncLog.uploadedOnItsOwn)"
    }
}
