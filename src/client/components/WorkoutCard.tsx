import { useState } from 'react';
import { deleteWorkout, downloadFit, type Workout } from '../api';
import { formatCompleted, formatSport, plannedSummary, sportIcon, stepLines } from '../format';
import { RecordedSession } from './RecordedSession';

/** One workout in full, as shown in the calendar's detail panel. */
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
        {workout.tags?.length ? ` · ${workout.tags.join(', ')}` : ''}
      </p>
      {workout.notes && <p className="note">{workout.notes}</p>}

      {workout.completed_at && <p className="done-note">✓ Done {formatCompleted(workout.completed_at)}</p>}
      {/* What the athlete said about the session, not what was planned for it — so it sits
          under the completion rather than up with the plan's own notes. */}
      {workout.comment && <blockquote className="comment">{workout.comment}</blockquote>}

      <pre>{stepLines(workout)}</pre>

      <RecordedSession workout={workout} />

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
