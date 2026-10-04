import type { Note, Workout, Window } from '../api';
import { calendarDays, longDate, shortDate, fromKey, toKey } from '../dates';
import { useFitDrop } from '../fitDrop';
import { plannedSummary, sportIcon } from '../format';

// Whole Monday-to-Sunday weeks, widened to cover every workout returned: the server's
// window is UTC and this calendar is local, so the edges disagree.
function windowCovering(window: Window, workouts: Workout[]): Window {
  return workouts.reduce(
    (span, workout) => ({
      from: workout.date < span.from ? workout.date : span.from,
      to: workout.date > span.to ? workout.date : span.to,
    }),
    window,
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

type Props = {
  window: Window;
  workouts: Workout[];
  notes: Note[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  onRecorded: () => void;
};

/** A workout on its day. A .fit dropped on it is recorded against it. */
function WorkoutChip({ workout, on, onSelect, onRecorded }: {
  workout: Workout;
  on: boolean;
  onSelect: () => void;
  onRecorded: () => void;
}) {
  const drop = useFitDrop(workout, onRecorded);
  const total = plannedSummary(workout.planned);
  const done = Boolean(workout.completed_at);
  const classes = ['chip', on && 'on', done && 'done', drop.over && 'drop', drop.busy && 'busy']
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <button
        className={classes}
        title={done ? `${workout.name} — done` : `${workout.name} — drop a .fit here to record it`}
        onClick={onSelect}
        {...drop.handlers}
      >
        <span>
          {/* The emoji carries the sport, so it needs the label a word would have. */}
          <span className="icon" role="img" aria-label={workout.sport}>
            {sportIcon(workout.sport)}
          </span>
          {done && (
            <span className="tick" role="img" aria-label="done">
              ✓
            </span>
          )}
          {workout.name}
        </span>
        {drop.busy ? <span className="total">Reading .fit…</span> : total && <span className="total">{total}</span>}
      </button>
      {drop.error && <span className="chip-error">{drop.error}</span>}
    </>
  );
}

export function Calendar({ window, workouts, notes, selected, onSelect, onRecorded }: Props) {
  const span = windowCovering(window, workouts);
  const days = calendarDays(span.from, span.to);
  const today = toKey(new Date());

  const byDate = new Map<string, Workout[]>();
  for (const workout of workouts) {
    byDate.set(workout.date, [...(byDate.get(workout.date) ?? []), workout]);
  }

  return (
    <section>
      <h2>
        {shortDate(fromKey(span.from))} – {shortDate(fromKey(span.to))}
      </h2>

      <div className="calendar">
        {WEEKDAYS.map((day) => (
          <span className="weekday" key={day}>
            {day}
          </span>
        ))}

        {days.map((day) => {
          const key = toKey(day);
          const outside = key < span.from || key > span.to;
          const classes = ['cell', outside && 'outside', key === today && 'today'].filter(Boolean).join(' ');

          return (
            <div className={classes} key={key}>
              <span className="num">{day.getDate()}</span>
              <span className="full">{longDate(day)}</span>

              <div className="entries">
                {!outside &&
                  notes
                    .filter((note) => note.date <= key && key <= note.end_date)
                    .map((note) => (
                      <span key={note.id} className="chip note" title={note.text}>
                        <span>📝 {note.text}</span>
                      </span>
                    ))}
                {!outside &&
                  (byDate.get(key) ?? []).map((workout) => {
                    const id = `${workout.date}/${workout.id}`;
                    return (
                      <WorkoutChip
                        key={workout.id}
                        workout={workout}
                        on={selected === id}
                        onSelect={() => onSelect(selected === id ? null : id)}
                        onRecorded={() => {
                          onRecorded();
                          onSelect(id);
                        }}
                      />
                    );
                  })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
