// The screen a session is run from: which interval, what it is aimed at, the figures that
// move, and the three buttons — pause, lap, stop.
//
// Two screens really. Indoors or outdoors is asked before anything starts, because it is the
// one thing about a session that cannot be changed once it has and that the plan cannot
// always settle: the same easy 40 minutes is a park or a treadmill depending on the weather.

import SwiftUI

@available(iOS 26.0, *)
struct RunView: View {
    let workout: PlannedWorkout
    let steps: [RunStep]

    @Environment(\.dismiss) private var dismiss
    @State private var indoors: Bool
    @State private var started = false

    init(workout: PlannedWorkout, steps: [RunStep]) {
        self.workout = workout
        self.steps = steps
        // The plan's own answer is what the picker opens on — a treadmill session is planned
        // as one — so the athlete who has nothing to change taps one button rather than two.
        _indoors = State(initialValue: Sports.location(workout.subSport) == .indoor)
    }

    var body: some View {
        if started {
            RunningView(workout: workout, steps: steps, indoors: indoors)
        } else {
            setup
        }
    }

    /// Answering the picker is not starting: `started` is its own flag, or moving the segment
    /// to look at the other label would begin the session under it.
    private var setup: some View {
        VStack(spacing: 24) {
            Spacer()
            Text(workout.name).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
            Text(Formats.summary(of: workout.planned)).foregroundStyle(.secondary)

            Picker("Where", selection: $indoors) {
                Text("Outdoors").tag(false)
                Text("Indoors").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 24)

            Text(indoors
                ? "No GPS: distance and pace come from the pedometer."
                : "GPS on, for your pace and the route.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Spacer()
            Button("Start", systemImage: "play.fill") { started = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            Button("Not now") { dismiss() }
                .padding(.bottom, 24)
        }
        .padding(.horizontal, 24)
    }
}

@available(iOS 26.0, *)
private struct RunningView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @StateObject private var runner: WorkoutRunner
    @State private var confirmingEnd = false

    init(workout: PlannedWorkout, steps: [RunStep], indoors: Bool) {
        _runner = StateObject(wrappedValue: WorkoutRunner(workout: workout, steps: steps, indoors: indoors))
    }

    var body: some View {
        VStack(spacing: 20) {
            heading
            readings
            Spacer(minLength: 0)
            controls
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .task { await runner.begin() }
        // The clock and the location updates outlive this view otherwise — the session does
        // not, and is not meant to: ending it is the End button's, not the screen's.
        .onDisappear { runner.stop() }
        .confirmationDialog("End this session?", isPresented: $confirmingEnd) {
            Button("End and save", role: .destructive) { Task { await finish() } }
            Button("Keep going", role: .cancel) {}
        } message: {
            Text("It will be saved to Health and sent up.")
        }
    }

    // --- Which interval, and what it is for --------------------------------------------------

    private var heading: some View {
        VStack(spacing: 4) {
            // The name, because a full-screen cover has no title bar to put it in and an
            // athlete who started the wrong session should be able to see that they did.
            Text(runner.workout.name).font(.subheadline).foregroundStyle(.secondary)

            Text(counted).font(.title2.weight(.semibold))

            if let step = runner.step {
                Text(step.title).font(.headline)
                if !step.line.isEmpty {
                    Text(step.line).font(.callout).foregroundStyle(.secondary)
                }
            } else {
                // Past the end of the plan, which a lap press is allowed to go: the athlete
                // is still running and the session still records, so it says where they are
                // rather than pretending there is a step here.
                Text("Past the plan").font(.headline).foregroundStyle(.secondary)
            }

            status
        }
        .multilineTextAlignment(.center)
    }

    /// "Interval 4 / 10", or just the number once the lap presses have run past the plan.
    private var counted: String {
        let at = runner.interval + 1
        return at <= runner.steps.count ? "Interval \(at) / \(runner.steps.count)" : "Interval \(at)"
    }

    @ViewBuilder
    private var status: some View {
        switch runner.phase {
        case .starting: Text("Starting…").font(.footnote).foregroundStyle(.secondary)
        case .paused: Text("Paused").font(.footnote).foregroundStyle(.orange)
        case .saving: Text("Saving…").font(.footnote).foregroundStyle(.secondary)
        case .saved: Text("Saved to Health").font(.footnote).foregroundStyle(.secondary)
        case .failed(let why): Text(why).font(.footnote).foregroundStyle(.red)
        case .running: EmptyView()
        }
    }

    // --- The figures -------------------------------------------------------------------------

    /// Two columns, and every row of them is a pair read across: the session's figure on the
    /// left and this interval's beside it, because what an athlete checks mid-interval is the
    /// difference. Which pairs there are is the **session's** sport, not the workout's — a
    /// recovered ride picked up from a run is still a ride.
    private var readings: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
            Reading(value: Formats.clock(runner.elapsed), unit: "total")
            Reading(value: Formats.clock(runner.intervalElapsed), unit: "interval")

            if runner.isCycling {
                Reading(value: runner.power.map(Formats.whole), unit: "watts")
                Reading(value: runner.intervalPower.map(Formats.whole), unit: "interval W")
            } else {
                Reading(value: runner.speedMS.flatMap { Formats.rate($0, cycling: false) }, unit: "per km")
                Reading(value: runner.intervalPaceSKm.map(Formats.clock), unit: "interval /km")
                Reading(value: runner.metres.map(Formats.distance), unit: "distance")
                Reading(value: runner.intervalMetres.map(Formats.distance), unit: "interval distance")
            }

            Reading(value: runner.cadence.map(Formats.whole), unit: runner.isCycling ? "rpm" : "spm")
            Reading(value: runner.heartRate.map(Formats.whole), unit: "bpm")
        }
    }

    // --- The three buttons -------------------------------------------------------------------

    @ViewBuilder
    private var controls: some View {
        VStack(spacing: 12) {
            switch runner.phase {
            case .running, .paused:
                Button("Next interval", systemImage: "forward.end.fill") { runner.nextInterval() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)

                HStack(spacing: 16) {
                    if runner.phase == .paused {
                        Button("Resume", systemImage: "play.fill") { runner.resume() }
                    } else {
                        Button("Pause", systemImage: "pause.fill") { runner.pause() }
                    }
                    Button("End", systemImage: "stop.fill") { confirmingEnd = true }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)

            case .starting, .saving:
                ProgressView()

            case .saved, .failed:
                Button("Done") { dismiss() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
        }
        .padding(.bottom, 24)
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

/// One figure, as big as it can be read at arm's length. A reading nothing has measured is a
/// dash rather than a zero — see `WorkoutRunner`.
@available(iOS 26.0, *)
private struct Reading: View {
    let value: String?
    let unit: String

    var body: some View {
        VStack(spacing: 0) {
            Text(value ?? "—")
                .font(.system(size: 40, weight: .medium, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.6)
                .lineLimit(1)
                .contentTransition(.numericText())
                .foregroundStyle(value == nil ? Color.secondary : Color.primary)
            Text(unit).font(.caption2).foregroundStyle(.secondary).textCase(.uppercase)
        }
    }
}
