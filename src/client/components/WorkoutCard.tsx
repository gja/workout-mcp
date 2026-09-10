import { useState } from 'react';
import { deleteWorkout, downloadFit, type Workout } from '../api';
import { formatSport, plannedSummary, stepLines } from '../format';

/**
 * One workout in full. Used both in the calendar's detail panel and in the
 * list below it, so the two can never drift apart.
 */
export function WorkoutCard({ workout, onChanged }: { workout: Workout; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      after?.();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const planned = plannedSummary(workout.planned);

  return (
    <article className="card">
      <header>
        <h3>{workout.name}</h3>
        <span className="id">{workout.id}</span>
      </header>

      <p className="note">
        {formatSport(workout)}
        {planned && ` · ${planned}`}
      </p>
      {workout.notes && <p className="note">{workout.notes}</p>}

      <pre>{stepLines(workout)}</pre>

      <div className="actions">
        <button className="link" disabled={busy} onClick={() => run(() => downloadFit(workout))}>
          Download .fit
        </button>
        <button
          className="link danger"
          disabled={busy}
          onClick={() => {
            if (!confirm(`Delete "${workout.name}" on ${workout.date}?`)) return;
            void run(() => deleteWorkout(workout), onChanged);
          }}
        >
          Delete
        </button>
      </div>

      {error && <p className="error">{error}</p>}
    </article>
  );
}
