import { useState } from 'react';
import { completeWorkout, deleteWorkout, downloadFit, uncompleteWorkout, type Workout } from '../api';
import { fromLocalInput, toLocalInput } from '../dates';
import { formatCompleted, formatSport, plannedSummary, sportIcon, stepLines } from '../format';

/** One workout in full, as shown in the calendar's detail panel. */
export function WorkoutCard({ workout, onChanged }: { workout: Workout; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Held locally so it can be corrected before it is sent. The card is keyed by
  // workout, so picking another day starts this over rather than carrying the last time.
  const [when, setWhen] = useState(() =>
    toLocalInput(workout.completed_at ? new Date(workout.completed_at) : new Date()),
  );

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
  const done = Boolean(workout.completed_at);

  return (
    <article className={`card${done ? ' done' : ''}`}>
      <header>
        <h3>
          <span className="icon" role="img" aria-label={workout.sport}>
            {sportIcon(workout.sport)}
          </span>
          {workout.name}
        </h3>
        <span className="id">{workout.id}</span>
      </header>

      <p className="note">
        {formatSport(workout)}
        {planned && ` · ${planned}`}
      </p>
      {workout.notes && <p className="note">{workout.notes}</p>}

      {workout.completed_at && <p className="done-note">✓ Done {formatCompleted(workout.completed_at)}</p>}

      <pre>{stepLines(workout)}</pre>

      <div className="complete">
        <label htmlFor={`done-at-${workout.id}`} className="note">
          {done ? 'Done at' : 'Mark done at'}
        </label>
        <input
          id={`done-at-${workout.id}`}
          type="datetime-local"
          value={when}
          onChange={(event) => setWhen(event.target.value)}
        />
        <button
          className="link"
          disabled={busy || when === ''}
          onClick={() => void run(() => completeWorkout(workout, fromLocalInput(when)), onChanged)}
        >
          {done ? 'Update' : 'Mark done'}
        </button>
        {done && (
          <button className="link danger" disabled={busy} onClick={() => void run(() => uncompleteWorkout(workout), onChanged)}>
            Not done
          </button>
        )}
      </div>

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
