// The screen a session is run from: which interval, what it is aimed at, the figures that
// move, and the controls. One screen for every sport this app records — a walk, a run and a
// ride differ in which figures are worth showing and in nothing else, which is a question
// `WorkoutView` asks the session rather than a reason to write it three times.
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
struct WorkoutStart: View {
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
            WorkoutView(runner: runner)
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

/// Not private: `WorkoutRecovery` puts this up too, for a session the app was handed on opening
/// rather than one started from a plan.
///
/// Laid out the way Apple's own workout screen is, because that is the one every athlete has
/// already learned to read at arm's length in the rain: black, values left-aligned and as
/// large as they go, their units under them in small caps, and everything that is a control
/// in one bar at the bottom where a thumb is. The figures themselves are unchanged.
@available(iOS 26.0, *)
struct WorkoutView: View {
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
    /// How far the lock has been dragged along its track, in points.
    @State private var slid: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 0) {
                if isSaving {
                    saving
                } else if saved {
                    summary
                } else {
                    heading
                    Spacer(minLength: 12)
                    readings
                }
                Spacer(minLength: 12)
                // Nothing to press while it is being written: the buttons are about a session
                // that is still going, and this one is not any more.
                if !isSaving { controls }
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
            Text(title)
                .font(.system(size: 26, weight: .bold, design: .rounded))
                .foregroundStyle(.white)

            if let line = runner.step?.line, !line.isEmpty {
                Text(line).font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary)
            }
            status
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "Workout complete" is what is said past the last step of a plan — not what is said by
    /// a session with no plan behind it at all, which is every recovered one whose workout
    /// could not be placed. That said complete over a recording still going.
    private var title: String {
        if let step = runner.step { return step.title }
        return runner.steps.isEmpty ? (runner.workout?.name ?? "Recording") : "Workout complete"
    }

    /// Closing a builder and writing a session into Health takes a moment, and a moment with
    /// nothing on the screen is a moment an athlete spends deciding whether it worked.
    private var saving: some View {
        VStack(alignment: .leading, spacing: 14) {
            ProgressView().controlSize(.large).tint(.white)
            Text("Saving to Health…")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Text("Keep the app open.")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What it came to, once it is in Health. Shown rather than dismissed straight past,
    /// because "it saved" is the one thing an athlete wants to be told at the end and the
    /// screen going away on its own says nothing.
    private var summary: some View {
        VStack(alignment: .leading, spacing: 26) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Workout saved")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .foregroundStyle(.white)
                Text("In Health, and on its way up.")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            LazyVGrid(
                columns: [
                    GridItem(.flexible(), alignment: .leading),
                    GridItem(.flexible(), alignment: .leading),
                ],
                spacing: 26
            ) {
                Reading(value: Formats.clock(runner.elapsed), unit: "total")
                Reading(value: runner.metres.map(Formats.distance), unit: "distance")
                if !runner.steps.isEmpty {
                    Reading(value: "\(runner.interval + 1)", unit: "intervals")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var status: some View {
        if runner.isPaused {
            Text("PAUSED").font(.caption.weight(.bold)).foregroundStyle(.yellow)
        }
        // A live session that refused something says so and carries on; only a save that
        // failed is a `failed` phase, and only that offers to try again.
        if let problem = runner.problem {
            Text(problem).font(.caption).foregroundStyle(.red)
        } else if case .failed(let why) = runner.phase {
            Text(why).font(.caption).foregroundStyle(.red)
        }
    }

    // --- The figures, unchanged ------------------------------------------------------------

    /// Two columns, and every row of them a pair read across: **this interval on the left and
    /// the session on the right**, so a glance down one column is the interval and a glance
    /// down the other is the whole of it. What an athlete checks mid-interval is the
    /// difference, and it is the same difference every row. Which pairs there are is the
    /// session's sport, not the workout's; the session's clock is in the bar below.
    private var readings: some View {
        LazyVGrid(
            columns: [
                GridItem(.flexible(), alignment: .leading),
                GridItem(.flexible(), alignment: .leading),
            ],
            spacing: 26
        ) {
            if runner.isCycling {
                Reading(value: runner.intervalPower.map(Formats.whole), unit: "interval w")
                Reading(value: runner.power.map(Formats.whole), unit: "watts")
            } else {
                Reading(value: runner.intervalPaceSKm.map(Formats.clock), unit: "interval pace")
                Reading(value: runner.speedMS.flatMap { Formats.rate($0, cycling: false) }, unit: "pace")
                Reading(value: runner.intervalMetres.map(Formats.distance), unit: "interval dist")
                Reading(value: runner.metres.map(Formats.distance), unit: "distance")
            }

            Reading(value: runner.cadence.map(Formats.whole), unit: runner.isCycling ? "rpm" : "spm")
            Reading(value: runner.heartRate.map(Formats.whole), unit: "bpm")
            Reading(value: Formats.clock(runner.intervalElapsed), unit: "interval")
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
            } else if isLive {
                buttons
                ending
            } else {
                // A lap, a pause and a lock are about a session that is going. Once one is
                // saved there is one thing left to do with this screen, so it is the only
                // thing on it.
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
                        // Dimmed, not merely deaf. A paused workout has no laps in it, and a
                        // lap button that looks live over one is a button to tap and wonder
                        // about — `lappable` is the session's answer, not this screen's.
                        .opacity(runner.lappable ? 1 : 0.3)
                }
                .disabled(!runner.lappable)

                Spacer()
                // One button either way: which transition it is belongs to the session, and
                // what it looks like follows the state the session reported.
                Button { runner.togglePause() } label: {
                    Group {
                        // The session has been asked and has not answered yet, which takes
                        // about a second. A dimmed pause glyph for that second reads as a
                        // button that has failed; a spinner reads as one that is working,
                        // and it is the truthful one — the glyph only changes when the
                        // session says so.
                        if runner.settling {
                            ProgressView().controlSize(.large).tint(.white)
                        } else {
                            Image(systemName: runner.isPaused ? "play.fill" : "pause.fill")
                                .font(.system(size: 32, weight: .bold))
                                .foregroundStyle(runner.isPaused ? Color.yellow : .white)
                        }
                    }
                    .frame(width: 88, height: 88)
                    .background(Circle().fill(
                        runner.isPaused ? Color.yellow.opacity(0.22) : Color.white.opacity(0.14)
                    ))
                }
                .disabled(!isLive || runner.settling)
                Spacer()

                // Where Apple keeps the heart rate mute, and the slot that balances the pause
                // into the middle. Reachable without pausing first, because pausing to lock
                // the screen would cost the recording the seconds spent deciding to.
                Button {
                    slid = 0
                    locked = true
                } label: {
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

    /// Slid rather than tapped, which is the whole point of having locked it, and slid rather
    /// than held because that is the gesture Apple's own lock uses and the one a hand already
    /// knows. It goes back where it came from unless it is taken most of the way.
    private var unlock: some View {
        GeometryReader { frame in
            let knob: CGFloat = 52
            let travel = max(frame.size.width - knob - 12, 1)

            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.07))

                Text("Unlock Controls")
                    .font(.system(size: 20, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .opacity(1 - Double(slid / travel))

                Image(systemName: "lock.fill")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: knob, height: knob)
                    .background(Circle().fill(Color.white.opacity(0.16)))
                    .offset(x: 6 + slid)
                    .gesture(
                        DragGesture()
                            .onChanged { slid = min(max(0, $0.translation.width), travel) }
                            .onEnded { _ in
                                if slid >= travel * 0.7 { locked = false }
                                withAnimation(.snappy) { slid = 0 }
                            }
                    )
            }
        }
        .frame(height: 64)
    }

    /// Ending is behind the pause, as it is on Apple's own screen, and that answers two
    /// things at once: there is no dialog to write, and the seconds spent deciding are not
    /// seconds anybody was moving. Nothing ends a running session in one tap.
    @ViewBuilder
    private var ending: some View {
        if isLive, runner.isPaused {
            Button { Task { await finish() } } label: {
                Label("End Workout", systemImage: "xmark")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(
                        RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .fill(Color.red.opacity(0.24))
                            .overlay(
                                RoundedRectangle(cornerRadius: 28, style: .continuous)
                                    .strokeBorder(Color.red.opacity(0.45), lineWidth: 1)
                            )
                    )
            }
        } else if failed {
            // A save that did not work is worth another go: the session is still there, and
            // until this the only way to try again was to kill the app.
            VStack(spacing: 10) {
                Button { Task { await finish() } } label: {
                    Label("Try again", systemImage: "arrow.clockwise")
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity, minHeight: 56)
                        .background(RoundedRectangle(cornerRadius: 28, style: .continuous)
                            .fill(Color.yellow))
                }
                Button("Leave it") { dismiss() }
                    .font(.system(size: 17))
                    .foregroundStyle(.secondary)
            }
        } else if saved {
            Button { dismiss() } label: {
                Text("Done")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity, minHeight: 56)
                    .background(RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(Color.white.opacity(0.14)))
            }
        }
    }

    /// Whether there is a recording to act on. Nothing but **End Workout** leaves a live
    /// session: *Done* belongs to a session already in Health and appears nowhere else, which
    /// is what it cost to have it sitting over one that was still going.
    private var isLive: Bool { runner.isRecording }

    private var saved: Bool {
        if case .saved = runner.phase { return true }
        return false
    }

    private var isSaving: Bool {
        if case .saving = runner.phase { return true }
        return false
    }

    private var failed: Bool {
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
    /// The screen stays on the summary rather than dismissing itself: what it has to say is
    /// that the session is in Health, and a screen that vanishes says the opposite of that.
    /// *Done* is what leaves.
    private func finish() async {
        await runner.end()
        guard case .saved = runner.phase else { return }
        await BackgroundSync.uploadWhatIsCertain()
        await model.refresh(using: session.client)
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
