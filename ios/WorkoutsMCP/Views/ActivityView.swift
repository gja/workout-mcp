// One recorded session: build the FIT file from it, share it, and post it against the
// workout it was for. The server keeps the numbers and not the file — see docs/stats.md.

import HealthKit
import SwiftUI

struct ActivityView: View {
    let activity: HKWorkout
    @ObservedObject var model: HomeModel
    @EnvironmentObject private var session: AppSession

    @State private var fit: URL?
    @State private var chosen: PlannedWorkout?
    @State private var building = false
    @State private var failure: String?

    var body: some View {
        Form {
            Section("Recorded") {
                LabeledContent("Sport", value: HealthAccess.isRide(activity) ? "Ride" : "Run")
                LabeledContent("Started", value: activity.startDate.formatted(date: .abbreviated, time: .shortened))
                LabeledContent("Duration", value: Formats.duration(activity.duration))
                if let metres = HealthAccess.distance(of: activity), metres > 0 {
                    LabeledContent("Distance", value: String(format: "%.2f km", metres / 1000))
                }
            }

            Section {
                Picker("Workout", selection: $chosen) {
                    Text("Not a planned workout").tag(PlannedWorkout?.none)
                    ForEach(model.workouts) { workout in
                        Text("\(workout.date) · \(workout.name)").tag(PlannedWorkout?.some(workout))
                    }
                }
            } header: {
                Text("This was")
            } footer: {
                Text("The id travels inside the file, so it can be matched again later.")
            }

            Section {
                Button(building ? "Building…" : "Generate .fit") {
                    Task { await build() }
                }
                .disabled(building)

                if let fit {
                    ShareLink(item: fit) { Label("Share \(fit.lastPathComponent)", systemImage: "square.and.arrow.up") }

                    Button("Upload to WorkoutsMCP") {
                        guard let chosen else { return }
                        Task { await model.upload(fit, from: activity, to: chosen, using: session.client) }
                    }
                    .disabled(chosen == nil || model.loading)
                }
            } footer: {
                if fit != nil && chosen == nil {
                    Text("Pick the planned workout above to upload it. The server ingests the file, works out the stats and marks the session done; it does not keep the file.")
                }
            }

            if let failure {
                Section { Text(failure).foregroundStyle(.red) }
            }
        }
        .navigationTitle("Session")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { chosen = chosen ?? model.suggestion(for: activity) }
        // The id is written into the file, so a different match is a different file.
        .onChange(of: chosen) { fit = nil }
    }

    private func build() async {
        building = true
        defer { building = false }

        do {
            // Rebuilt whenever the match changes: the workout id is written into the file.
            fit = try await model.buildFit(for: activity, matching: chosen)
            failure = nil
        } catch {
            failure = error.localizedDescription
            fit = nil
        }
    }
}
