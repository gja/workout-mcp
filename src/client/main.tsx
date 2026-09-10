import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentUser, listWorkouts, signOut, type Me, type Workout } from './api';
import { relativeDate } from './dates';
import { Calendar } from './components/Calendar';
import { SignIn } from './components/SignIn';
import { WorkoutCard } from './components/WorkoutCard';
import { ConnectToClaude } from './components/ConnectToClaude';
import './styles.css';

function Dashboard({ me }: { me: Me }) {
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listWorkouts().then(
      ({ workouts: found }) => setWorkouts(found),
      (failure: Error) => setError(failure.message),
    );
  }, []);

  useEffect(reload, [reload]);

  // A workout deleted while selected simply falls out of the list, and the
  // panel goes with it — no cleanup needed.
  const open = workouts.find((workout) => `${workout.date}/${workout.id}` === selected);

  const byDate = workouts.reduce<Array<[string, Workout[]]>>((groups, workout) => {
    const last = groups[groups.length - 1];
    if (last && last[0] === workout.date) last[1].push(workout);
    else groups.push([workout.date, [workout]]);
    return groups;
  }, []);

  return (
    <>
      <div className="row">
        <span className="note">{me.email ?? 'Signed in'}</span>
        <button className="link" onClick={() => void signOut().then(() => location.reload())}>
          Sign out
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <Calendar window={me.window} workouts={workouts} selected={selected} onSelect={setSelected} />
      {open && <WorkoutCard workout={open} onChanged={reload} />}

      <section>
        <h2>Planned workouts</h2>
        {workouts.length === 0 && <p className="empty">No workouts planned in this window.</p>}
        {byDate.map(([date, onDate]) => (
          <div className="day" key={date}>
            <h3>{relativeDate(date)}</h3>
            {onDate.map((workout) => (
              <WorkoutCard key={workout.id} workout={workout} onChanged={reload} />
            ))}
          </div>
        ))}
      </section>

      <ConnectToClaude />
    </>
  );
}

function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    void currentUser().then(setMe);
  }, []);

  if (me === undefined) return null;

  return (
    <main>
      <h1>Workouts</h1>
      <p className="sub">Planned sessions in the window the server keeps. Download any of them as a Garmin FIT file.</p>
      {me ? <Dashboard me={me} /> : <SignIn intro="Sign in to see your planned workouts." />}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
