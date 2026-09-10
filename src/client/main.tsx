import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
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
  const panel = useRef<HTMLDivElement>(null);

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

  // Picking a day off the calendar should bring its workout into view, since
  // the panel opens below the fold on a short viewport. Keyed on the selection
  // rather than on `open`, so a reload of the same workout does not re-scroll.
  useEffect(() => {
    if (selected) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected]);

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

      {workouts.length === 0 && <p className="empty">No workouts planned in this window.</p>}

      {open && (
        <div className="day" ref={panel}>
          <h3>{relativeDate(open.date)}</h3>
          <WorkoutCard workout={open} onChanged={reload} />
        </div>
      )}

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
