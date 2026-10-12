import { useRef, useState } from 'react';
import { createWorkout, quickAdd, type WorkoutInput } from '../api';
import { startOfToday, toKey } from '../dates';
import { openSection } from './Accordion';
import { CONNECT_SECTION_ID } from './ConnectToClaude';

/**
 * A sentence in, a workout out: the server drafts the JSON and saves nothing, and the
 * ordinary create saves it once the athlete has looked. See docs/quick-add.md.
 */
export function QuickAdd({ onCreated }: { onCreated: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [date, setDate] = useState(() => toKey(startOfToday()));
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState<string | null>(null);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = () => {
    setDraft(null);
    setError(null);
    dialog.current?.showModal();
  };

  const makeDraft = () =>
    run(async () => {
      const drafted = await quickAdd(date, description);
      setDraft(JSON.stringify(drafted.workout, null, 2));
      setSummary(drafted.summary);
    });

  const save = () =>
    run(async () => {
      await createWorkout({ ...(JSON.parse(draft ?? '') as WorkoutInput), date });
      dialog.current?.close();
      setDescription('');
      onCreated();
    });

  const connect = () => {
    dialog.current?.close();
    openSection(CONNECT_SECTION_ID);
  };

  return (
    <>
      <button onClick={open}>+ Quick add</button>
      {/* Escape is held off mid-request too: a save landing after a cancel would add a workout nobody kept. */}
      <dialog className="quick-add" ref={dialog} onCancel={(event) => busy && event.preventDefault()}>
        <h3>Quick add</h3>
        <p className="note">
          Quick add cannot see your planned or completed workouts: it only turns a sentence into a
          workout. For planning around your training,{' '}
          <button className="link" onClick={connect}>
            connect Claude
          </button>
          .
        </p>

        <div className="row">
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </div>
        <textarea
          rows={3}
          maxLength={500}
          placeholder="Easy run 25 min, then strides: 20 s on, 2 min off, x6"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />

        <div className="row end">
          <button disabled={busy || !description.trim()} onClick={makeDraft}>
            {draft === null ? 'Draft' : 'Draft again'}
          </button>
        </div>

        {draft !== null && (
          <>
            <p className="note">Nothing is saved yet. Not right? Reword it and draft again.</p>
            <pre>{summary}</pre>
            <details>
              <summary className="note">Edit the JSON (the preview above will not follow)</summary>
              <textarea className="json" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </details>
          </>
        )}
        {error && <p className="error">{error}</p>}

        <footer className="row end">
          <button disabled={busy} onClick={() => dialog.current?.close()}>
            Cancel
          </button>
          <button className="primary" disabled={busy || draft === null} onClick={save}>
            Save workout
          </button>
        </footer>
      </dialog>
    </>
  );
}
