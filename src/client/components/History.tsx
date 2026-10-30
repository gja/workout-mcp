import { useEffect, useMemo, useState } from 'react';
import { listWorkouts, type Workout } from '../api';
import { longDate, fromKey, shiftKey, startOfToday, toKey } from '../dates';
import { plannedSummary, sessionLine, sportIcon } from '../format';

/** What the range opens on. The server reaches back without limit; this is only the default. */
const DEFAULT_DAYS_BACK = 365;

/** A number the filters can bound, read off the recording — or, for distance and time, the plan. */
type Measure = {
  key: string;
  label: string;
  unit: string;
  read: (workout: Workout) => number | null;
  /** Pace is typed as `m:ss`; everything else is a plain number. */
  parse?: (text: string) => number | null;
};

const minutesAndSeconds = (text: string): number | null => {
  const match = /^(\d+)(?::(\d{1,2}))?$/.exec(text.trim());
  return match ? Number(match[1]) * 60 + Number(match[2] ?? 0) : null;
};

const session = (workout: Workout) => workout.stats?.session ?? null;

const MEASURES: Measure[] = [
  {
    key: 'distance',
    label: 'Distance',
    unit: 'km',
    read: (w) => {
      const meters = session(w)?.distance_m ?? w.planned?.meters ?? null;
      return meters ? meters / 1000 : null;
    },
  },
  {
    key: 'time',
    label: 'Time',
    unit: 'min',
    read: (w) => {
      const recorded = session(w);
      const seconds = recorded ? (recorded.moving_s ?? recorded.elapsed_s) : (w.planned?.seconds ?? null);
      return seconds ? seconds / 60 : null;
    },
  },
  { key: 'pace', label: 'Avg pace', unit: 'min/km', read: (w) => session(w)?.avg_pace_s_km ?? null, parse: minutesAndSeconds },
  { key: 'avg_hr', label: 'Avg HR', unit: 'bpm', read: (w) => session(w)?.avg_hr ?? null },
  { key: 'max_hr', label: 'Max HR', unit: 'bpm', read: (w) => session(w)?.max_hr ?? null },
  { key: 'avg_power', label: 'Avg power', unit: 'W', read: (w) => session(w)?.avg_power_w ?? null },
  { key: 'max_power', label: 'Max power', unit: 'W', read: (w) => session(w)?.max_power_w ?? null },
];

type Bounds = Record<string, { min: string; max: string }>;

const parseBound = (measure: Measure, text: string): number | null => {
  if (text.trim() === '') return null;
  const value = measure.parse ? measure.parse(text) : Number(text);
  return value === null || Number.isNaN(value) ? null : value;
};

/** A workout with nothing to measure is out as soon as that measure is bounded. */
function withinBounds(workout: Workout, bounds: Bounds): boolean {
  return MEASURES.every((measure) => {
    const bound = bounds[measure.key];
    if (!bound) return true;
    const min = parseBound(measure, bound.min);
    const max = parseBound(measure, bound.max);
    if (min === null && max === null) return true;
    const value = measure.read(workout);
    if (value === null) return false;
    // Either way round, so a pace typed fastest-first still means the band between.
    const [low, high] = min !== null && max !== null && min > max ? [max, min] : [min, max];
    return (low === null || value >= low) && (high === null || value <= high);
  });
}

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
  const [sport, setSport] = useState('all');
  const [bounds, setBounds] = useState<Bounds>({});

  useEffect(() => {
    if (!from || !to) return;
    setError(null);
    // History is what was done; what was only planned stays on the calendar.
    listWorkouts(to, from).then(
      ({ workouts: found }) => setWorkouts(found.filter((workout) => workout.completed_at)),
      (failure: Error) => setError(failure.message),
    );
  }, [from, to]);

  const sports = useMemo(() => [...new Set((workouts ?? []).map((w) => w.sport))].sort(), [workouts]);

  const matching = (workouts ?? []).filter(
    (workout) => (sport === 'all' || workout.sport === sport) && withinBounds(workout, bounds),
  );
  // Newest first: the list is for looking back, the calendar for looking ahead.
  const shown = [...matching].reverse();

  const setBound = (key: string, end: 'min' | 'max', text: string) =>
    setBounds((current) => ({ ...current, [key]: { ...(current[key] ?? { min: '', max: '' }), [end]: text } }));
  const filtered = sport !== 'all' || Object.values(bounds).some((b) => b.min || b.max);

  return (
    <>
      <p className="row">
        <a className="link" href="/">← Back to the calendar</a>
      </p>
      <h2>Completed workouts</h2>
      <div className="row">
        <label className="field">
          From <input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="field">
          To <input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} />
        </label>
        <button className="primary" disabled={matching.length === 0} onClick={() => downloadJsonl(matching, from, to)}>
          Export JSONL
        </button>
      </div>

      <div className="filters">
        <label className="field">
          Type
          <select value={sport} onChange={(event) => setSport(event.target.value)}>
            <option value="all">All</option>
            {sports.map((each) => (
              <option key={each} value={each}>
                {each}
              </option>
            ))}
          </select>
        </label>
        {MEASURES.map((measure) => (
          <label className="field" key={measure.key}>
            {measure.label}
            <input
              inputMode={measure.parse ? 'text' : 'decimal'}
              placeholder="min"
              value={bounds[measure.key]?.min ?? ''}
              onChange={(event) => setBound(measure.key, 'min', event.target.value)}
            />
            –
            <input
              inputMode={measure.parse ? 'text' : 'decimal'}
              placeholder="max"
              value={bounds[measure.key]?.max ?? ''}
              onChange={(event) => setBound(measure.key, 'max', event.target.value)}
            />
            <span className="unit">{measure.unit}</span>
          </label>
        ))}
        {filtered && (
          <button
            className="link"
            onClick={() => {
              setSport('all');
              setBounds({});
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {workouts && (
        <p className="note">
          {filtered ? `${matching.length} of ${workouts.length}` : workouts.length} completed workout
          {workouts.length === 1 ? '' : 's'}.{filtered && ' Export takes only these.'}
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
