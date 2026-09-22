// The plan as a list of intervals to run, one after another.
//
// `ResolvedStep` is a tree — a repeat block holds the steps inside it — which is the shape
// the plan is written in and read in, and the wrong shape for a screen counting out
// "4 / 10". This flattens it: eight times through a pair of steps is sixteen intervals,
// which is what the athlete presses lap through.
//
// Nothing here decides what a step *means*: the durations and targets are the server's,
// already resolved. See docs/workouts.md.

import Foundation

struct RunStep {
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
