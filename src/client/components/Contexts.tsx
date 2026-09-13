import { useEffect, useState } from 'react';
import { clearContext, downloadContextBackup, listContexts, saveContext, type ContextDocument } from '../api';
import { Accordion, Section } from './Accordion';

/** What the athlete has said, at a glance, without opening the document. */
const hint = (document: ContextDocument): string =>
  document.custom ? 'Yours' : document.markdown === null ? 'Not set' : 'Built-in';

function Editor({ document }: { document: ContextDocument }) {
  const [saved, setSaved] = useState(document);
  const [draft, setDraft] = useState(document.markdown ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const adopt = (next: ContextDocument) => {
    setSaved(next);
    setDraft(next.markdown ?? '');
  };

  const run = async (action: () => Promise<ContextDocument>) => {
    setError(null);
    setBusy(true);
    try {
      adopt(await action());
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revert = () => {
    if (!confirm(`Discard your ${saved.label.toLowerCase()} and go back to the built-in one?`)) return;
    void run(() => clearContext(saved.kind));
  };

  const dirty = draft !== (saved.markdown ?? '');
  const onBuiltIn = !saved.custom && saved.has_built_in;

  return (
    <>
      <p className="note">{saved.purpose}</p>
      <p className="note">
        {saved.writable_over_mcp ? (
          <>
            An assistant can read this with <code>get_context</code> and replace it with{' '}
            <code>update_context</code> — so it will ask before changing it.
          </>
        ) : (
          <>
            Read-only over MCP, through <code>get_context</code>. This panel and{' '}
            <code>PUT /api/context/{saved.kind}</code> are the two ways to change it.
          </>
        )}
      </p>

      <textarea
        className="context"
        spellCheck={false}
        placeholder={saved.markdown === null ? 'Nothing set yet — write it in markdown.' : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />

      <div className="actions">
        <button className="primary" disabled={busy || !dirty} onClick={() => void run(() => saveContext(saved.kind, draft))}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="link" disabled={busy} onClick={() => setDraft(saved.markdown ?? '')}>
            Discard changes
          </button>
        )}
        {saved.custom && saved.has_built_in && (
          <button className="link danger" disabled={busy} onClick={revert}>
            Use the built-in one
          </button>
        )}
        {saved.custom && !saved.has_built_in && (
          <button className="link danger" disabled={busy} onClick={() => void run(() => clearContext(saved.kind))}>
            Clear
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      <p className="note">
        {saved.custom
          ? `Yours, last saved ${new Date(saved.updated_at!).toLocaleString()}.`
          : onBuiltIn
            ? 'The built-in document. Saving makes it yours to edit.'
            : 'Not set — an assistant is told so rather than guessing.'}
      </p>
    </>
  );
}

/** The four documents an assistant reads before it plans anything. */
export function Contexts() {
  const [documents, setDocuments] = useState<ContextDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const exportAll = async () => {
    setError(null);
    setExporting(true);
    try {
      await downloadContextBackup();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    listContexts().then(
      ({ contexts }) => setDocuments(contexts),
      (failure: Error) => setError(failure.message),
    );
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!documents) return <p className="note">Loading…</p>;

  return (
    <>
      <p className="note">
        Markdown an assistant reads before it writes you a session or picks a day for one. It is context, not
        configuration — nothing in it is validated, and none of it is a setting.
      </p>
      <Accordion>
        {documents.map((document) => (
          <Section key={document.kind} group="context" title={document.label} hint={hint(document)}>
            <Editor document={document} />
          </Section>
        ))}
      </Accordion>

      <div className="actions">
        <button disabled={exporting} onClick={() => void exportAll()}>
          {exporting ? 'Exporting…' : 'Export context'}
        </button>
      </div>
      <p className="note">
        Every document above as one <code>backup-context.zip</code> — a markdown file each, plus a{' '}
        <code>manifest.json</code> saying what is in it.
      </p>
    </>
  );
}
