import { useEffect, useState } from 'react';
import { listWorkouts, type Workout } from '../api';
import { longDate, fromKey, shiftKey, startOfToday, toKey } from '../dates';
import { plannedSummary, sessionLine, sportIcon } from '../format';

/** What the range opens on. The server reaches back without limit; this is only the default. */
const DEFAULT_DAYS_BACK = 365;

/** One workout a line, as listed, so a whole history can be handed to an assistant. See docs/api.md. */
function downloadJsonl(workouts: Workout[], from: string, to: string): void {
  const body = workouts.map((workout) => JSON.stringify(workout)).join('\n') + '\n';
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], { type: 'application/x-ndjson' }));
  link.download = `workouts-${from}-to-${to}.jsonl`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function History() {
  const day = toKey(startOfToday());
  const [from, setFrom] = useState(shiftKey(day, -DEFAULT_DAYS_BACK));
  const [to, setTo] = useState(day);
  const [workouts, setWorkouts] = useState<Workout[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    setError(null);
    listWorkouts(to, from).then(({ workouts: found }) => setWorkouts(found), (failure: Error) => setError(failure.message));
  }, [from, to]);

  // Newest first: the list is for looking back, the calendar for looking ahead.
  const shown = [...(workouts ?? [])].reverse();

  return (
    <>
      <p className="row">
        <a className="link" href="/">← Back to the calendar</a>
      </p>
      <h2>All workouts</h2>
      <div className="row">
        <label className="field">
          From <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="field">
          To <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button
          className="primary"
          disabled={!workouts || workouts.length === 0}
          onClick={() => workouts && downloadJsonl(workouts, from, to)}
        >
          Export JSONL
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {workouts && (
        <p className="note">
          {workouts.length} workout{workouts.length === 1 ? '' : 's'}, {workouts.filter((w) => w.completed_at).length} done.
        </p>
      )}

      <ul className="history">
        {shown.map((workout) => (
          <li key={workout.id}>
            <span className="history-date">{longDate(fromKey(workout.date))}</span>
            <a className="history-name" href={`/workout/${workout.id}`}>
              <span className="icon" role="img" aria-label={workout.sport}>
                {sportIcon(workout.sport)}
              </span>
              {workout.completed_at && (
                <span className="tick" role="img" aria-label="done">
                  ✓{' '}
                </span>
              )}
              {workout.name}
            </a>
            <span className="history-figures">
              {workout.stats?.session ? sessionLine(workout.stats.session) : plannedSummary(workout.planned)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
