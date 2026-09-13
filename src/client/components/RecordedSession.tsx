import { useEffect, useState } from 'react';
import { getWorkoutStats, type Lap, type Workout, type WorkoutStats } from '../api';
import { flagNotes, formatBand, lapActual, lapHeadline, lapLength, sessionLine } from '../format';

/** What the lap was aimed at, and what it actually did on that same metric. */
function Aimed({ lap }: { lap: Lap }) {
  if (!lap.target) return <td className="lap-actual muted">{lapHeadline(lap) ?? '—'}</td>;

  const actual = lapActual(lap, lap.target.metric);
  const inBand = Math.round(lap.target.pct_time_in_band * 100);
  return (
    <td className="lap-actual">
      {actual ?? '—'}
      <span className={`lap-sub ${inBand >= 80 ? 'in-band' : ''}`}>{inBand}% in band</span>
    </td>
  );
}

/** The laps beside the steps they were run for. Pure, so it can be rendered anywhere. */
export function LapTable({ laps }: { laps: Lap[] }) {
  return (
    <div className="laps-scroll">
      <table className="laps">
        <thead>
          <tr>
            <th>Lap</th>
            <th>Target</th>
            <th>Actual</th>
          </tr>
        </thead>
        <tbody>
          {laps.map((lap) => (
            <tr key={lap.index} className={lap.role}>
              <td>
                <span className="lap-num">{lap.index + 1}</span>
                <span className="lap-step">{lap.planned_step_name ?? lap.role}</span>
                {/* The rep goes under the name rather than beside it: on a phone that column
                    is the one with room to spare, and the numbers beside it have none. */}
                <span className="lap-sub">
                  {[lap.rep_number === null ? null : `rep ${lap.rep_number}`, lapLength(lap)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </td>
              <td className="lap-target muted">{lap.target ? formatBand(lap.target) : '—'}</td>
              <Aimed lap={lap} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The session the athlete actually recorded, beside the plan it was for.
 *
 * The laps are their own read — a workout carries only the totals — so this fetches
 * them when the card is opened rather than making every listing pay for them.
 */
export function RecordedSession({ workout }: { workout: Workout }) {
  const [stats, setStats] = useState<WorkoutStats | null>(null);
  const summary = workout.stats;

  useEffect(() => {
    if (!summary?.session) return;
    let live = true;
    void getWorkoutStats(workout).then(
      (loaded) => live && setStats(loaded),
      // Nothing is said: the totals above are still true, and the laps are a nicety.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [workout.date, workout.id, summary?.computed_at]);

  if (!summary) return null;

  const notes = flagNotes(summary.flags);
  const matched = (stats?.laps ?? []).filter((lap) => lap.planned_step_index !== null).length > 0;

  return (
    <section className="recorded">
      <h4>What you did</h4>
      {summary.session ? <p className="note">{sessionLine(summary.session)}</p> : null}
      {notes.map((note) => (
        <p className="note" key={note}>
          {note}
        </p>
      ))}

      {matched && <LapTable laps={stats!.laps} />}
    </section>
  );
}
