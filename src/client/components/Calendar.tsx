import type { Workout, Window } from '../api';
import { calendarDays, longDate, shortDate, fromKey, toKey } from '../dates';
import { plannedSummary } from '../format';

/**
 * The retention window as whole Sunday-to-Saturday weeks.
 *
 * The window comes from the server, which computes it in UTC; it is widened to
 * cover any workout actually returned so an edge-of-window session cannot fall
 * off a calendar drawn in local time.
 */
function windowCovering(window: Window, workouts: Workout[]): Window {
  return workouts.reduce(
    (span, workout) => ({
      from: workout.date < span.from ? workout.date : span.from,
      to: workout.date > span.to ? workout.date : span.to,
    }),
    window,
  );
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Props = {
  window: Window;
  workouts: Workout[];
  selected: string | null;
  onSelect: (key: string | null) => void;
};

export function Calendar({ window, workouts, selected, onSelect }: Props) {
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
                  (byDate.get(key) ?? []).map((workout) => {
                    const id = `${workout.date}/${workout.id}`;
                    const total = plannedSummary(workout.planned);
                    return (
                      <button
                        key={workout.id}
                        className={`chip${selected === id ? ' on' : ''}`}
                        title={workout.name}
                        onClick={() => onSelect(selected === id ? null : id)}
                      >
                        <span>{workout.name}</span>
                        {total && <span className="total">{total}</span>}
                      </button>
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
