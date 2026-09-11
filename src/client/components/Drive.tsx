import { useEffect, useState } from 'react';
import { configureDrive, disconnectDrive, getConfig, syncDrive, type DriveReport, type DriveStatus } from '../api';

/** What a finished run amounts to, in one line. */
function describeCopy(report: DriveReport): string {
  const parts: string[] = [];
  if (report.copied) parts.push(`copied ${report.copied}`);
  if (report.remaining) parts.push(`${report.remaining} left for the next run`);
  return parts.length > 0 ? `Synced: ${parts.join(', ')}.` : 'No new completed workouts to copy.';
}

/** The Google Drive panel: where completed workouts go, and whether any have. */
export function Drive() {
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const reload = () => {
    getConfig().then((config) => setDrive(config.drive), (failure: Error) => setError(failure.message));
  };

  useEffect(reload, []);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const connect = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const { sync } = await configureDrive(pasted);
      setPasted('');
      // A drive that stores but cannot copy is worth saying here, not only as a standing error.
      setNote(sync.error ? `Connected, but the first copy failed: ${sync.error}` : describeCopy(sync));
      reload();
    });
  };

  const sync = () =>
    void run(async () => {
      const report = await syncDrive();
      if (report.error) throw new Error(report.error);
      setNote(describeCopy(report));
      reload();
    });

  const disconnect = () => {
    if (!confirm('Forget this drive? The files already copied into it are left alone.')) return;
    void run(async () => {
      await disconnectDrive();
      reload();
    });
  };

  // Only the first load is silent: after that, saying nothing hides an unconfigured Worker.
  if (drive === null) return error === null ? null : <p className="error">{error}</p>;

  if (!drive.configured) {
    return (
      <p className="error">
        Drive copying is disabled until <code>GOOGLE_DRIVE_CLIENT_EMAIL</code> and{' '}
        <code>GOOGLE_DRIVE_PRIVATE_KEY</code> are set on the Worker.
      </p>
    );
  }

  return (
    <>
      <p className="note">
        Every completed workout you record on a connected training platform is copied to your own Google Drive as
        the FIT file your watch produced, so you can analyse it wherever you like. It is relayed straight across and
        never stored here.
      </p>
      <p className="note">
        Files land at <code>{drive.path_template}</code>. It has to be a <strong>shared drive</strong>, not a folder —
        a service account owns what it uploads and has no storage of its own, so a folder in your own Drive has no
        quota to charge the file to. Shared drives are a Google Workspace feature, so a free Gmail account cannot use
        this.
      </p>

      <article className="card">
        <header>
          <h3>Google Workspace Drive</h3>
          <span className="id">{drive.connected ? (drive.drive_name ?? 'connected') : 'not connected'}</span>
        </header>

        {drive.connected ? (
          <>
            <p className="note">
              {drive.copied === 0
                ? 'No completed workouts copied yet.'
                : `${drive.copied} completed workout${drive.copied === 1 ? '' : 's'} copied.`}{' '}
              Only the ones you marked as a race on the platform count — an ordinary session stays where it is.
            </p>
            {drive.recent.length > 0 && (
              <ul className="note">
                {drive.recent.map((copy) => (
                  <li key={`${copy.platform}/${copy.remote_id}`}>
                    <code>{copy.path}</code>
                  </li>
                ))}
              </ul>
            )}
            {drive.last_error && <p className="error">Last copy failed — {drive.last_error}</p>}
            <div className="actions">
              <button className="link" disabled={busy} onClick={sync}>
                Copy now
              </button>
              <button className="link danger" disabled={busy} onClick={disconnect}>
                Forget drive
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="note">
              In Google Drive, open your shared drive, add{' '}
              <code>{drive.service_account ?? 'the service account'}</code> as a <strong>Contributor</strong>, then
              paste the drive's link here.
            </p>
            <div className="row">
              <form onSubmit={connect}>
                <input
                  type="text"
                  autoComplete="off"
                  placeholder="Shared drive link or id"
                  value={pasted}
                  onChange={(event) => setPasted(event.target.value)}
                />
                <button className="primary" type="submit" disabled={busy || pasted.trim() === ''}>
                  Connect
                </button>
              </form>
            </div>
          </>
        )}

        {note && <p className="note">{note}</p>}
        {error && <p className="error">{error}</p>}
      </article>
    </>
  );
}
