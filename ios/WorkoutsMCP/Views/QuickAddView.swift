// A sentence turned into a workout by the server's small model, read back before it is
// saved. Not a planner: it sees nothing of the training around it. See docs/quick-add.md.

import SwiftUI

struct QuickAddView: View {
    @EnvironmentObject private var session: AppSession
    @Environment(\.dismiss) private var dismiss

    @State var date: Date
    /// The days the Planned tab can show it on.
    let days: ClosedRange<Date>
    /// Handed the day it landed on, so the calendar can move there. Run after the sheet closes.
    let onSaved: (Date) async -> Void

    @State private var description = ""
    @State private var draft: QuickAddDraft?
    @State private var busy = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    // Locked while a draft is out, or it would land carrying the day before.
                    DatePicker("Date", selection: $date, in: days, displayedComponents: .date)
                        .disabled(busy)
                    TextField("Easy run 25 min, then strides: 20 s on, 2 min off, x6", text: $description, axis: .vertical)
                        .lineLimit(3 ... 6)
                        .disabled(busy)
                    Button(action: makeDraft) {
                        HStack {
                            Text(draft == nil ? "Draft" : "Draft again")
                            if busy { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(busy || description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                } footer: {
                    Text("Quick add doesn't have access to your planned or executed workouts, goals or other context. Please connect via Claude or ChatGPT for a richer experience.")
                }

                if let draft {
                    Section {
                        Text(draft.summary).font(.callout.monospaced())
                    } header: {
                        Text("Draft")
                    } footer: {
                        Text("Nothing is saved yet. Not right? Reword it and draft again.")
                    }
                }

                if let problem {
                    Section { Text(problem).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Quick add")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // Not mid-request: a save that finishes after Cancel would add a workout nobody kept.
                    Button("Cancel") { dismiss() }.disabled(busy)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save).disabled(busy || draft == nil)
                }
            }
            // The draft carries the day it was made for; a new day needs a new draft.
            .onChange(of: date) { draft = nil }
            .interactiveDismissDisabled(busy)
        }
    }

    private func makeDraft() {
        run {
            draft = try await client().quickAdd(on: date, description: description)
        }
    }

    private func save() {
        guard let draft else { return }
        run {
            try await client().create(draft)
            dismiss()
            Task { await onSaved(draft.date) }
        }
    }

    private func client() throws -> WorkoutsClient {
        guard let client = session.client else { throw ApiError(status: 401, message: "Sign in again to use quick add.") }
        return client
    }

    private func run(_ action: @escaping () async throws -> Void) {
        problem = nil
        busy = true
        Task {
            defer { busy = false }
            do { try await action() } catch { problem = error.localizedDescription }
        }
    }
}
