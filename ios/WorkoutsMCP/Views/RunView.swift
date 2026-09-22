// The screen a session is run from: three numbers, a pause and a way to stop.
//
// Three because they are the three an athlete reads mid-effort — how fast, how far, how
// hard — and a fourth would be read by nobody at 5 a.m. with a phone on an armband. What
// was planned is a line above them, not a step being counted out; see docs/ios.md.

import SwiftUI

@available(iOS 26.0, *)
struct RunView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @StateObject private var runner: WorkoutRunner
    @State private var confirmingEnd = false

    init(workout: PlannedWorkout) {
        _runner = StateObject(wrappedValue: WorkoutRunner(workout: workout))
    }

    var body: some View {
        VStack(spacing: 28) {
            heading

            Reading(value: rate, unit: cycling ? "km/h" : "per km")
            Reading(value: runner.metres.map(Formats.distance), unit: "distance")
            Reading(value: runner.heartRate.map { "\(Formats.whole($0))" }, unit: "bpm")

            Spacer()
            controls
        }
        .padding(.horizontal, 24)
        .padding(.top, 24)
        .task { await runner.begin() }
        .confirmationDialog("End this session?", isPresented: $confirmingEnd) {
            Button("End and save", role: .destructive) { Task { await finish() } }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("It will be saved to Health and sent up.")
        }
    }

    private var heading: some View {
        VStack(spacing: 6) {
            // The name, because a full-screen cover has no title bar to put it in and an
            // athlete who started the wrong session should be able to see that they did.
            Text(runner.workout.name)
                .font(.headline)
                .multilineTextAlignment(.center)

            Text(Formats.clock(runner.elapsed))
                .font(.system(size: 64, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText())

            switch runner.phase {
            case .starting:
                Text("Starting…").foregroundStyle(.secondary)
            case .paused:
                Text("Paused").foregroundStyle(.orange)
            case .saving:
                Text("Saving…").foregroundStyle(.secondary)
            case .saved:
                Text("Saved to Health").foregroundStyle(.secondary)
            case .failed(let why):
                Text(why).foregroundStyle(.red).multilineTextAlignment(.center)
            case .running:
                Text(Formats.summary(of: runner.workout.planned)).foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }

    @ViewBuilder
    private var controls: some View {
        HStack(spacing: 16) {
            switch runner.phase {
            case .running:
                Button("Pause", systemImage: "pause.fill") { runner.pause() }
                    .buttonStyle(.bordered)
                Button("End", systemImage: "stop.fill") { confirmingEnd = true }
                    .buttonStyle(.borderedProminent)
            case .paused:
                Button("Resume", systemImage: "play.fill") { runner.resume() }
                    .buttonStyle(.bordered)
                Button("End", systemImage: "stop.fill") { confirmingEnd = true }
                    .buttonStyle(.borderedProminent)
            case .starting, .saving:
                ProgressView()
            case .saved, .failed:
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .controlSize(.large)
        .padding(.bottom, 24)
    }

    private var cycling: Bool { runner.workout.sport == "cycling" }

    private var rate: String? {
        runner.speedMS.flatMap { Formats.rate($0, cycling: cycling) }
    }

    /// The upload is the same one a wake would do, on the same terms: this session names its
    /// planned workout, so nothing here has to tell it which. Awaited before the screen goes,
    /// because the athlete is still looking at it and a failure has nowhere else to appear.
    private func finish() async {
        await runner.end()
        guard case .saved = runner.phase else { return }
        await BackgroundSync.uploadWhatIsCertain()
        await model.refresh(using: session.client)
        dismiss()
    }
}

/// One figure, as big as it can be read at arm's length. A reading nothing has measured is
/// a dash rather than a zero — see `WorkoutRunner`.
@available(iOS 26.0, *)
private struct Reading: View {
    let value: String?
    let unit: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value ?? "—")
                .font(.system(size: 52, weight: .medium, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText())
                .foregroundStyle(value == nil ? Color.secondary : Color.primary)
            Text(unit).font(.caption).foregroundStyle(.secondary).textCase(.uppercase)
        }
    }
}
