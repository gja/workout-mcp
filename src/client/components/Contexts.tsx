import { useEffect, useState } from 'react';
import { clearContext, downloadContextBackup, listContexts, saveContext, type ContextDocument } from '../api';
import { Accordion, Section } from './Accordion';

/** What the athlete has said, at a glance, without opening the document. */
const hint = (document: ContextDocument): string =>
  document.custom ? 'Yours' : document.markdown === null ? 'Not set' : 'Built-in';

/**
 * The document is the parent's, so the section header and the editor cannot
 * disagree about it after a save. Only the draft is held here, and it is seeded
 * once: a write answers with what was stored, and adopting that is the only
 * thing that may move the text out from under whoever is typing.
 */
function Editor({
  document,
  onChanged,
}: {
  document: ContextDocument;
  onChanged: (next: ContextDocument) => void;
}) {
  const [draft, setDraft] = useState(document.markdown ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<ContextDocument>) => {
    setError(null);
    setBusy(true);
    try {
      const next = await action();
      setDraft(next.markdown ?? '');
      onChanged(next);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Both of these throw the athlete's own words away; only one of them leaves something behind.
  const discard = () => {
    const warning = document.has_built_in
      ? `Discard your ${document.label.toLowerCase()} and go back to the built-in one?`
      : `Clear your ${document.label.toLowerCase()}? There is no built-in one to fall back to.`;
    if (!confirm(warning)) return;
    void run(() => clearContext(document.kind));
  };

  const dirty = draft !== (document.markdown ?? '');
  const onBuiltIn = !document.custom && document.has_built_in;

  return (
    <>
      <p className="note">{document.purpose}</p>
      <p className="note">
        {document.writable_over_mcp ? (
          <>
            An assistant reads this with <code>{document.read_tool}</code> and replaces it with{' '}
            <code>update_context</code> — so it will ask before changing it.
          </>
        ) : (
          <>
            Read-only over MCP, through <code>{document.read_tool}</code>. This panel and{' '}
            <code>PUT /api/context/{document.kind}</code> are the two ways to change it.
          </>
        )}
      </p>

      <textarea
        className="context"
        spellCheck={false}
        // Disabled while a write is in flight, because its answer replaces this text.
        disabled={busy}
        placeholder={document.markdown === null ? 'Nothing set yet — write it in markdown.' : undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />

      <div className="actions">
        <button
          className="primary"
          disabled={busy || !dirty}
          onClick={() => void run(() => saveContext(document.kind, draft))}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {dirty && (
          <button className="link" disabled={busy} onClick={() => setDraft(document.markdown ?? '')}>
            Discard changes
          </button>
        )}
        {document.custom && (
          <button className="link danger" disabled={busy} onClick={discard}>
            {document.has_built_in ? 'Use the built-in one' : 'Clear'}
          </button>
        )}
      </div>

      {error && <p className="error">{error}</p>}
      <p className="note">
        {document.custom
          ? `Yours, last saved ${new Date(document.updated_at!).toLocaleString()}.`
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
  // Kept apart from the export's: unmounting the editors over a failed download
  // would throw away every unsaved draft on the page.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    listContexts().then(
      ({ contexts }) => setDocuments(contexts),
      (failure: Error) => setLoadError(failure.message),
    );
  }, []);

  const exportAll = async () => {
    setExportError(null);
    setExporting(true);
    try {
      await downloadContextBackup();
    } catch (failure) {
      setExportError((failure as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const replace = (next: ContextDocument) =>
    setDocuments((current) =>
      (current ?? []).map((document) => (document.kind === next.kind ? next : document)),
    );

  if (loadError) return <p className="error">{loadError}</p>;
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
            <Editor document={document} onChanged={replace} />
          </Section>
        ))}
      </Accordion>

      <div className="actions">
        <button disabled={exporting} onClick={() => void exportAll()}>
          {exporting ? 'Exporting…' : 'Export context'}
        </button>
      </div>
      {exportError && <p className="error">{exportError}</p>}
      <p className="note">
        Every document above as one <code>backup-context.zip</code> — a markdown file each, plus a{' '}
        <code>manifest.json</code> saying what is in it.
      </p>
    </>
  );
}
