// The screen a session is run from: which interval, what it is aimed at, the figures that
// move, and the three buttons — pause, lap, stop.
//
// Two screens really. Indoors or outdoors is asked before anything starts, because it is the
// one thing about a session that cannot be changed once it has and that the plan cannot
// always settle: the same easy 40 minutes is a park or a treadmill depending on the weather.

// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import HealthKit
import SwiftUI

@available(iOS 26.0, *)
struct RunView: View {
    let workout: PlannedWorkout
    let steps: [RunStep]

    @Environment(\.dismiss) private var dismiss
    @State private var indoors: Bool
    /// Made and started by the button, and held here rather than inside the screen below,
    /// which does not appear until there is something recording for it to be about.
    @State private var runner: WorkoutRunner?
    @State private var starting = false
    @State private var counting: Int?
    @State private var failure: String?

    init(workout: PlannedWorkout, steps: [RunStep]) {
        self.workout = workout
        self.steps = steps
        // The plan's own answer is what the picker opens on — a treadmill session is planned
        // as one — so the athlete who has nothing to change taps one button rather than two.
        _indoors = State(initialValue: Sports.location(workout.subSport) == .indoor)
    }

    var body: some View {
        if let runner {
            RunningView(runner: runner)
        } else {
            setup
        }
    }

    /// The screen stays here until there is a session running with its first lap open. A run
    /// screen over a session that never started is the one thing an athlete cannot tell from
    /// a working one, and they find out a minute in, outdoors — which is how the first
    /// recording went.
    private var setup: some View {
        VStack(spacing: 24) {
            Spacer()
            Text(workout.name).font(.title2.weight(.semibold)).multilineTextAlignment(.center)
            Text(Formats.summary(of: workout.planned)).foregroundStyle(.secondary)

            // The count the flattening produced, before anybody walks anywhere on it. A plan
            // whose repeats did not come apart is six intervals that say three, and the only
            // place that is cheap to notice is here.
            Text(steps.isEmpty ? "No steps" : "\(steps.count) intervals")
                .font(.footnote)
                .foregroundStyle(steps.isEmpty ? Color.red : Color.secondary)

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

            if let failure {
                Text(failure).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }

            Spacer()
            if let counting {
                VStack(spacing: 4) {
                    Text("\(counting)")
                        .font(.system(size: 96, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                    if !indoors {
                        Text("Getting a fix…").font(.footnote).foregroundStyle(.secondary)
                    }
                }
            } else if starting {
                ProgressView("Starting…")
            } else {
                Button("Start", systemImage: "play.fill") { Task { await start() } }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(steps.isEmpty)
            }
            Button("Not now") { dismiss() }
                .padding(.bottom, 24)
                .disabled(starting)
        }
        .padding(.horizontal, 24)
    }

    private func start() async {
        starting = true
        failure = nil
        defer {
            starting = false
            counting = nil
        }

        let made = WorkoutRunner(workout: workout, steps: steps, indoors: indoors)
        // The count-in is not ceremony: the receiver is already running by the time it starts,
        // so the three seconds are three seconds of lock the recording does not have to spend.
        made.warmUp()
        for second in stride(from: 3, through: 1, by: -1) {
            counting = second
            try? await Task.sleep(for: .seconds(1))
        }
        counting = nil

        guard await made.begin() else {
            if case .failed(let why) = made.phase { failure = why }
            return
        }
        runner = made
    }
}

/// Not private: `RunRecovery` puts this up too, for a session the app was handed on opening
/// rather than one started from a plan.
///
/// Laid out the way Apple's own workout screen is, because that is the one every athlete has
/// already learned to read at arm's length in the rain: black, values left-aligned and as
/// large as they go, their units under them in small caps, and everything that is a control
/// in one bar at the bottom where a thumb is. The figures themselves are unchanged.
@available(iOS 26.0, *)
struct RunningView: View {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss

    /// Observed rather than owned: whoever put this up made the runner and started it, and
    /// this screen is only ever shown for one that is already recording.
    @ObservedObject var runner: WorkoutRunner

    @State private var showingNext = false
    /// Controls off, figures on. A phone goes in a pocket or under a sleeve mid-session and
    /// comes out having been tapped by a thigh; what it must not have been tapped into is the
    /// next interval or the end of the recording.
    @State private var locked = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                heading
                Spacer(minLength: 12)
                readings
                Spacer(minLength: 12)
                controls
            }
            .padding(.horizontal, 22)
            .padding(.top, 8)
        }
        .preferredColorScheme(.dark)
        // The clock and the location updates outlive this view otherwise — the session does
        // not, and is not meant to: ending it is the End button's, not the screen's.
        .onDisappear { runner.stop() }
        .sheet(isPresented: $showingNext) {
            NextUp(steps: runner.steps, current: runner.interval)
        }
    }

    // --- What this interval is ----------------------------------------------------------

    private var heading: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(runner.step?.title ?? "Workout complete")
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(.white)

            if let line = runner.step?.line, !line.isEmpty {
                Text(line).font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary)
            }
            status
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var status: some View {
        switch runner.phase {
        case .paused: Text("PAUSED").font(.caption.weight(.bold)).foregroundStyle(.yellow)
        case .saving: Text("SAVING…").font(.caption.weight(.bold)).foregroundStyle(.secondary)
        case .saved: Text("SAVED TO HEALTH").font(.caption.weight(.bold)).foregroundStyle(.secondary)
        case .failed(let why): Text(why).font(.caption).foregroundStyle(.red)
        case .starting, .running: EmptyView()
        }
    }

    // --- The figures, unchanged ------------------------------------------------------------

    /// Two columns, and every row of them a pair read across: the session's figure on the
    /// left and this interval's beside it, because what an athlete checks mid-interval is the
    /// difference. Which pairs there are is the **session's** sport, not the workout's.
    private var readings: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), alignment: .leading),
                GridItem(.flexible(), alignment: .leading),
            ],
            spacing: 26
        ) {
            Reading(value: Formats.clock(runner.intervalElapsed), unit: "interval")

            if runner.isCycling {
                Reading(value: runner.power.map(Formats.whole), unit: "watts")
                Reading(value: runner.intervalPower.map(Formats.whole), unit: "interval w")
            } else {
                Reading(value: runner.speedMS.flatMap { Formats.rate($0, cycling: false) }, unit: "pace")
                Reading(value: runner.intervalPaceSKm.map(Formats.clock), unit: "interval pace")
                Reading(value: runner.metres.map(Formats.distance), unit: "distance")
                Reading(value: runner.intervalMetres.map(Formats.distance), unit: "interval dist")
            }

            Reading(value: runner.cadence.map(Formats.whole), unit: runner.isCycling ? "rpm" : "spm")
            Reading(value: runner.heartRate.map(Formats.whole), unit: "bpm")
        }
    }

    // --- The bar a thumb reaches -----------------------------------------------------------

    private var controls: some View {
        VStack(spacing: 14) {
            HStack {
                Image(systemName: glyph)
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.green)
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color.green.opacity(0.18)))

                Spacer()
                // The one figure that is about the whole session sits where Apple puts it,
                // so the grid above is only ever this interval and the totals beside it.
                Text(Formats.clock(runner.elapsed))
                    .font(.system(size: 34, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(.yellow)
                Spacer()

                // Where the activity rings are on Apple's, which say nothing an athlete
                // running a plan wants mid-interval. What is coming does.
                Button { showingNext = true } label: {
                    Image(systemName: "list.bullet")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(Circle().fill(Color.white.opacity(0.12)))
                }
                .disabled(locked)
                .opacity(locked ? 0.3 : 1)
            }

            if locked {
                unlock
            } else {
                buttons
                ending
            }
        }
        .padding(.vertical, 16)
        .padding(.horizontal, 16)
        .background(RoundedRectangle(cornerRadius: 34, style: .continuous).fill(Color(white: 0.11)))
        .padding(.bottom, 8)
    }

    private var buttons: some View {
        Group {
            HStack {
                Button { runner.nextInterval() } label: {
                    Text("\(runner.interval + 1)")
                        .font(.system(size: 26, weight: .semibold, design: .rounded))
                        .foregroundStyle(.white)
                        .frame(width: 68, height: 68)
                        .background(Circle().stroke(Color.white.opacity(0.35), lineWidth: 2))
                }
                .disabled(!isLive)

                Spacer()
                Button {
                    if runner.phase == .paused { runner.resume() } else { runner.pause() }
                } label: {
                    Image(systemName: runner.phase == .paused ? "arrow.clockwise" : "pause.fill")
                        .font(.system(size: 32, weight: .bold))
                        .foregroundStyle(runner.phase == .paused ? Color.yellow : .white)
                        .frame(width: 88, height: 88)
                        .background(Circle().fill(
                            runner.phase == .paused ? Color.yellow.opacity(0.22) : Color.white.opacity(0.14)
                        ))
                }
                .disabled(!isLive)
                Spacer()

                // Where Apple keeps the heart rate mute, and the slot that balances the pause
                // into the middle. Reachable without pausing first, because pausing to lock
                // the screen would cost the recording the seconds spent deciding to.
                Button { locked = true } label: {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 24, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 68, height: 68)
                        .background(Circle().fill(Color.white.opacity(0.14)))
                }
                .disabled(!isLive)
            }
        }
    }

    /// Held rather than tapped, which is the whole point of having locked it.
    private var unlock: some View {
        HStack(spacing: 14) {
            Image(systemName: "lock.fill")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 52, height: 52)
                .background(Circle().fill(Color.white.opacity(0.16)))

            Text("Hold to Unlock")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(6)
        .frame(maxWidth: .infinity)
        .background(Capsule().fill(Color.white.opacity(0.07)))
        .contentShape(Capsule())
        .onLongPressGesture(minimumDuration: 0.8) { locked = false }
    }

    /// Ending is behind the pause, as it is on Apple's own screen, and that answers two
    /// things at once: there is no dialog to write, and the seconds spent deciding are not
    /// seconds anybody was moving. Nothing ends a running session in one tap.
    @ViewBuilder
    private var ending: some View {
        if runner.phase == .paused {
            Button { Task { await finish() } } label: {
                Label("End Workout", systemImage: "xmark")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(Color.red.opacity(0.18)))
            }
        } else if done {
            Button { dismiss() } label: {
                Text("Done")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(Color.white.opacity(0.14)))
            }
        } else if case .saving = runner.phase {
            ProgressView().frame(minHeight: 56)
        }
    }

    /// Whether there is a recording to act on. A saved or failed session still shows the bar,
    /// so the one button that still means something is the one that gets out of here.
    private var isLive: Bool { runner.phase == .running || runner.phase == .paused }

    private var done: Bool {
        if case .saved = runner.phase { return true }
        if case .failed = runner.phase { return true }
        return false
    }

    private var glyph: String {
        if runner.isCycling { return "bicycle" }
        return runner.workout?.sport == "running" ? "figure.run" : "figure.walk"
    }

    /// The upload is the same one a wake would do, on the same terms: this session names its
    /// planned workout, so nothing here has to tell it which. Awaited before the screen goes,
    /// because the athlete is still looking at it and a failure has nowhere else to appear.
    private func finish() async {
        guard isLive else {
            dismiss()
            return
        }
        await runner.end()
        guard case .saved = runner.phase else { return }
        await BackgroundSync.uploadWhatIsCertain()
        await model.refresh(using: session.client)
        dismiss()
    }
}

/// One figure, as large as it goes, with what it is underneath in the small caps Apple uses.
/// A reading nothing has measured is a dash rather than a zero — see `WorkoutRunner`.
@available(iOS 26.0, *)
private struct Reading: View {
    let value: String?
    let unit: String

    var body: some View {
        VStack(alignment: .leading, spacing: -2) {
            Text(value ?? "—")
                .font(.system(size: 46, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .minimumScaleFactor(0.5)
                .lineLimit(1)
                .contentTransition(.numericText())
                .foregroundStyle(value == nil ? Color.secondary : Color.white)

            Text(unit.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What is coming, in the place the activity rings are on Apple's screen. The whole plan
/// rather than only the next step: an athlete asking what is next is usually asking how much
/// of this is left.
@available(iOS 26.0, *)
private struct NextUp: View {
    let steps: [RunStep]
    let current: Int

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List(steps.indices, id: \.self) { index in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("\(index + 1)")
                        .font(.callout.weight(.semibold).monospacedDigit())
                        .foregroundStyle(index == current ? Color.accentColor : .secondary)
                        .frame(width: 24, alignment: .trailing)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(steps[index].title)
                            .font(.body.weight(index == current ? .semibold : .regular))
                        if !steps[index].line.isEmpty {
                            Text(steps[index].line).font(.caption).foregroundStyle(.secondary)
                        }
                    }

                    Spacer()
                    if index == current {
                        Text("NOW").font(.caption2.weight(.bold)).foregroundStyle(Color.accentColor)
                    }
                }
                .listRowBackground(index == current ? Color.accentColor.opacity(0.12) : nil)
            }
            .navigationTitle("The plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
        }
        .presentationDetents([.medium, .large])
    }
}

#endif
