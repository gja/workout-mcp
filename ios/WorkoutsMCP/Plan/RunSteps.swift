// The plan as a list of intervals to run, one after another.
//
// `ResolvedStep` is a tree — a repeat block holds the steps inside it — which is the shape
// the plan is written in and read in, and the wrong shape for a screen counting out
// "4 / 10". This flattens it: eight times through a pair of steps is sixteen intervals,
// which is what the athlete presses lap through.
//
// Nothing here decides what a step *means*: the durations and targets are the server's,
// already resolved. See docs/workouts.md.

// Compiled only where `ON_PHONE_RECORDING` is — Debug, and not an archive. See
// "Recording it on the phone" in docs/ios.md.

#if ON_PHONE_RECORDING
import Foundation

struct RunStep: Codable {
    let title: String
    let duration: PlanDuration
    let targets: [PlanTarget]

    /// "800 m @ 4:00-4:15/km" — what this interval is, in one line. Empty for a step with
    /// neither, which is a step that ends when the athlete says it does.
    var line: String {
        let band = targets.compactMap { Formats.describe($0) }.joined(separator: " + ")
        let planned = Formats.describe(duration)
        return [planned, band].filter { !$0.isEmpty }.joined(separator: " @ ")
    }

    /// How far this step runs, where it is measured in metres — what the interval distance is
    /// counting towards, and what advances it. Nil for a step measured in time or in taps.
    var metres: Double? {
        if case .distance(let metres) = duration { return metres }
        return nil
    }

    /// The same for a step measured in time.
    var seconds: Double? {
        if case .time(let seconds) = duration { return seconds }
        return nil
    }

    /// What is said when this interval starts — *Now: Tempo. 4 minutes at target pace 4
    /// minutes to 4 minutes 15 per kilometre.* In words, because a synthesiser reads `line`
    /// as punctuation; and without the interval number, which is on the screen for anyone who
    /// wants it and is not what an athlete needs told at the moment a step changes.
    var spoken: String {
        let band = targets.compactMap { Spoken.target($0) }.joined(separator: ", ")
        let aim = band.isEmpty ? Spoken.duration(duration) : "\(Spoken.duration(duration)) at target \(band)"
        return "Now: \(title). \(aim)."
    }

    static func of(_ steps: [ResolvedStep]) -> [RunStep] {
        var flat: [RunStep] = []
        walk(steps, into: &flat)
        return flat
    }

    private static func walk(_ steps: [ResolvedStep], into flat: inout [RunStep]) {
        for step in steps {
            switch step {
            case .block(let times, let inner):
                // Expanded rather than counted, because the interval an athlete is on is the
                // fourth of sixteen, not the fourth of two on the second time round.
                for _ in 0 ..< max(times, 1) { walk(inner, into: &flat) }

            case .effort(let effort):
                flat.append(RunStep(
                    title: effort.name ?? effort.intensity.capitalized,
                    duration: effort.duration,
                    targets: [effort.target, effort.secondaryTarget].compactMap { $0 }
                ))
            }
        }
    }
}

#endif
