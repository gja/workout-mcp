import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentUser, listWorkouts, signOut, type Me, type Workout } from './api';
import { relativeDate } from './dates';
import { Accordion, Section } from './components/Accordion';
import { ApiTokens } from './components/ApiTokens';
import { Calendar } from './components/Calendar';
import { ConnectedApps } from './components/ConnectedApps';
import { ConnectToClaude } from './components/ConnectToClaude';
import { Drive } from './components/Drive';
import { Faq } from './components/Faq';
import { Platforms } from './components/Platforms';
import { SignIn } from './components/SignIn';
import { WorkoutCard } from './components/WorkoutCard';
import './styles.css';

/** `/workout/<id>` opens that session. The Worker serves the dashboard there; the path is read back here. */
const linkedWorkout = (): string | null => /^\/workout\/([^/]+)$/.exec(location.pathname)?.[1] ?? null;

function Dashboard({ me }: { me: Me }) {
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  // Resolved against the first list that arrives, because an id is only unique within a date.
  const pending = useRef(linkedWorkout());

  const reload = useCallback(() => {
    listWorkouts().then(
      ({ workouts: found }) => {
        setWorkouts(found);
        if (!pending.current) return;
        const target = found.find((workout) => workout.id === pending.current);
        pending.current = null;
        if (target) setSelected(`${target.date}/${target.id}`);
        else setMissing(true);
      },
      (failure: Error) => setError(failure.message),
    );
  }, []);

  useEffect(reload, [reload]);

  // A workout deleted while selected falls out of the list, and the panel with it.
  const open = workouts.find((workout) => `${workout.date}/${workout.id}` === selected);

  // Keyed on the selection, not on `open`, so reloading the same workout does not re-scroll.
  useEffect(() => {
    if (selected) panel.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selected]);

  return (
    <>
      {error && <p className="error">{error}</p>}
      {missing && (
        <p className="note">That workout is not in the current window — it may have been deleted or moved.</p>
      )}

      <Calendar window={me.window} workouts={workouts} selected={selected} onSelect={setSelected} />

      {workouts.length === 0 && <p className="empty">No workouts planned in this window.</p>}

      {open && (
        <div className="day" ref={panel}>
          <h3>{relativeDate(open.date)}</h3>
          {/* Keyed, so the card's completion time is seeded from this workout, not the last. */}
          <WorkoutCard key={selected} workout={open} onChanged={reload} />
        </div>
      )}

      <section>
        <h2>Setup</h2>
        <Accordion>
          <Section group="setup" title="Integrations" hint="intervals.icu">
            <Platforms onSynced={reload} />
          </Section>
          <Section group="setup" title="Google Drive" hint="Race files">
            <Drive />
          </Section>
          <Section group="setup" title="Connect to Claude" hint="Custom connector">
            <ConnectToClaude />
          </Section>
          <Section group="setup" title="API tokens" hint="Other MCP hosts">
            <ApiTokens />
          </Section>
          <Section group="setup" title="Connected apps" hint="Approved clients">
            <ConnectedApps />
          </Section>
        </Accordion>
      </section>
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
      <header className="masthead">
        <div>
          <h1>WorkoutsMCP</h1>
          <p className="sub">
            Plan structured workouts with an assistant, sync them to your training platform, and export any of them as
            a Garmin FIT file.
          </p>
        </div>
        {me && (
          <div className="whoami">
            <span className="note">{me.email ?? 'Signed in'}</span>
            <button className="link" onClick={() => void signOut().then(() => location.reload())}>
              Sign out
            </button>
          </div>
        )}
      </header>

      {me ? (
        <Dashboard me={me} />
      ) : (
        <SignIn intro="Sign in to see your planned workouts." returnTo={location.pathname} />
      )}

      <Faq />

      <footer className="colophon">
        <a href="/privacy-policy">Privacy policy</a>
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
