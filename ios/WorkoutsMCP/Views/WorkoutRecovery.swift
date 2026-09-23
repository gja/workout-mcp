// A recording the app was not looking at, offered the moment it opens.
//
// HealthKit holds a workout session, not this process, so one survives a force-quit and a
// crash — and until this existed the only way back to it was to guess which planned workout
// it had been started from and tap into that. Somebody who guessed wrong had a session they
// could not stop. So the app asks on opening instead: carry on, or end it and send it up.
//
// The modifier itself is not switched out, only its body, so `RootView` can name it either
// way. See docs/ios.md.

import HealthKit
import SwiftUI

struct WorkoutRecovery: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        #if ON_PHONE_RECORDING
        if #available(iOS 26.0, *) {
            content.modifier(Offer())
        } else {
            content
        }
        #else
        content
        #endif
    }
}

#if ON_PHONE_RECORDING
@available(iOS 26.0, *)
private struct Offer: ViewModifier {
    @EnvironmentObject private var session: AppSession
    @EnvironmentObject private var model: AppModel

    @State private var running: HKWorkoutSession?
    @State private var asking = false
    @State private var continuing = false
    @State private var workout: PlannedWorkout?
    @State private var steps: [RunStep] = []
    @State private var runner: WorkoutRunner?
    @State private var failure: String?

    func body(content: Content) -> some View {
        content
            .task { await look() }
            .alert("Still recording", isPresented: $asking) {
                Button("Continue") { Task { await carryOn() } }
                Button("End and save", role: .destructive) { Task { await finish() } }
            } message: {
                Text(started)
            }
            .fullScreenCover(isPresented: $continuing) {
                if let runner { WorkoutView(runner: runner) }
            }
    }

    private var started: String {
        if let failure { return "It could not be saved: \(failure)" }
        guard let at = running?.startDate else { return "A session on this phone is still recording." }
        return "A session started at \(at.formatted(date: .omitted, time: .shortened)) is still recording on this phone."
    }

    /// Only asked once a launch, and only where there is something to ask about. A phone with
    /// no session going answers this in a round trip and says nothing.
    private func look() async {
        guard running == nil, let found = await WorkoutRunner.active() else { return }
        running = found
        asking = true
    }

    /// The plan is fetched here rather than when the session is found, because opening the
    /// app starts the listing and this at the same moment and the listing usually loses.
    private func carryOn() async {
        guard let made = await adopted() else { return }

        guard await recording(made) else {
            // Not recording after all: HealthKit hands back a session that has ended as
            // readily as one going, and `begin` saves that rather than screening it.
            await settle(made)
            return
        }
        continuing = true
    }

    /// Ended without ever opening the screen, and uploaded on the terms every other session
    /// is: it names its own workout in its metadata, so nothing here has to say which.
    private func finish() async {
        guard let made = await adopted() else { return }

        // Only where it is still going: one that had already ended was saved by `begin`, and
        // ending it a second time is a finished builder being asked to finish again.
        if await recording(made) { await made.end() }
        await settle(made)
    }

    /// Whether there is a session under this runner to act on, beginning it only where there
    /// is not — beginning one already recording would adopt the session a second time. Not
    /// `isRecording || begin()`: `||` takes its right side as an autoclosure, and an
    /// autoclosure cannot await.
    private func recording(_ made: WorkoutRunner) async -> Bool {
        if made.isRecording { return true }
        return await made.begin()
    }

    /// **One** runner for the session, however many times this offer is answered. A second
    /// one adopting the same session makes itself the delegate, and the first is then waiting
    /// on a state change it will never be told about — which is a save hanging until its
    /// limit runs out, on a screen that has already given up.
    private func adopted() async -> WorkoutRunner? {
        if let runner { return runner }
        guard let running else { return nil }

        await place()
        let made = WorkoutRunner(workout: workout, steps: steps, indoors: false, recovered: running)
        runner = made
        return made
    }

    /// A save that did not happen must not clear the session: nothing else would offer it
    /// again, and the athlete would be told nothing about a recording now beyond reach.
    private func settle(_ made: WorkoutRunner) async {
        guard case .saved = made.phase else {
            if case .failed(let why) = made.phase { failure = why }
            asking = true
            return
        }

        running = nil
        failure = nil
        await BackgroundSync.uploadWhatIsCertain()
        await model.refresh(using: session.client)
    }

    /// What the session says it was for. A key with no workout behind it any more — deleted
    /// upstream, or a plan that has not loaded — is not an error: the session is still
    /// recorded and still uploaded, and only the name and the steps are missing.
    private func place() async {
        guard workout == nil, let running, let key = WorkoutRunner.workoutKey(of: running) else { return }

        // What the session wrote down when it started, which is everything the screen needs
        // and costs nothing to read. The name is the listing's to add and the upload names
        // itself out of the session's own metadata, so neither is worth a round trip on a
        // phone that is outdoors and may have no signal.
        if let kept = Underway.steps(forWorkout: key) {
            steps = kept
            return
        }

        // Only where nothing was written down — a session started by an older build. Opening
        // the app starts the listing and this at the same moment, and the listing usually
        // loses, which is what left a recovered session with a screen of dashes.
        if model.workouts.isEmpty { await model.refresh(using: session.client) }
        guard let planned = model.workouts.first(where: { $0.key == key }) else { return }

        workout = planned
        guard let client = session.client else { return }
        if let plan = try? await client.plan(for: planned) { steps = RunStep.of(plan.steps) }
    }
}
#endif
