import { useEffect, useState } from 'react';
import {
  getWorkoutLibrary,
  resetWorkoutLibrary,
  saveWorkoutLibrary,
  type WorkoutLibrary as Library,
} from '../api';

/** The athlete edits it here; the assistant only ever reads it back. */
export function WorkoutLibrary() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The textarea is seeded once per load, so typing is never overwritten by a refetch.
  const adopt = (next: Library) => {
    setLibrary(next);
    setDraft(next.markdown);
  };

  useEffect(() => {
    getWorkoutLibrary().then(adopt, (failure: Error) => setError(failure.message));
  }, []);

  const run = async (action: () => Promise<Library>) => {
    setError(null);
    setSaving(true);
    try {
      adopt(await action());
      setSaved(true);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (!confirm('Replace your library with the built-in one? Your version is not kept.')) return;
    void run(resetWorkoutLibrary);
  };

  if (!library) return error ? <p className="error">{error}</p> : <p className="note">Loading…</p>;

  const dirty = draft !== library.markdown;

  return (
    <>
      <p className="note">
        Markdown an assistant reads before it writes you a session: the sets you train with, how they are built, and
        how your plan is meant to progress. It is context, not configuration — nothing in it is validated. Until you
        save your own, everyone gets the built-in triathlon library.
      </p>
      <p className="note">
        Over MCP it is read-only, through <code>get_workout_library</code>. This panel and{' '}
        <code>PUT /api/workout-library</code> are the two ways to change it.
      </p>

      <textarea
        className="library"
        spellCheck={false}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setSaved(false);
        }}
      />

      <div className="actions">
        <button className="primary" disabled={saving || !dirty} onClick={() => void run(() => saveWorkoutLibrary(draft))}>
          {saving ? 'Saving…' : 'Save library'}
        </button>
        {dirty && (
          <button className="link" disabled={saving} onClick={() => setDraft(library.markdown)}>
            Discard changes
          </button>
        )}
        {library.custom && (
          <button className="link danger" disabled={saving} onClick={reset}>
            Use the built-in library
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      {saved && !dirty && <p className="note">Saved.</p>}
      <p className="note">
        {library.custom
          ? `Your own library, last saved ${new Date(library.updated_at!).toLocaleString()}.`
          : 'The built-in library. Saving makes it yours to edit.'}
      </p>
    </>
  );
}
