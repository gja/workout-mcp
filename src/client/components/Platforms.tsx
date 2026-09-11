import { useEffect, useState } from 'react';
import {
  connectPlatform,
  disconnectPlatform,
  listPlatforms,
  syncPlatform,
  type Platform,
  type SyncReport,
} from '../api';

/** What a finished run amounts to, in one line. */
function describeSync(report: SyncReport): string {
  const parts: string[] = [];
  if (report.pushed) parts.push(`pushed ${report.pushed}`);
  if (report.removed) parts.push(`removed ${report.removed}`);
  if (report.completed) parts.push(`marked ${report.completed} done`);
  if (report.remaining) parts.push(`${report.remaining} left for the next run`);
  return parts.length > 0 ? `Synced: ${parts.join(', ')}.` : 'Already up to date.';
}

/** `onSynced` reloads the calendar: a sync is how a completion recorded upstream arrives. */
function PlatformCard({
  platform,
  onChanged,
  onSynced,
}: {
  platform: Platform;
  onChanged: () => void;
  onSynced: () => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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
      const { sync } = await connectPlatform(platform.id, key);
      setKey('');
      // A key that stores but cannot sync is worth saying here, not only as a standing error.
      setNote(sync.error ? `Connected, but the first sync failed: ${sync.error}` : describeSync(sync));
      onChanged();
      onSynced();
    });
  };

  const sync = () =>
    void run(async () => {
      const report = await syncPlatform(platform.id);
      if (report.error) throw new Error(report.error);
      setNote(describeSync(report));
      onChanged();
      onSynced();
    });

  const disconnect = () => {
    if (!confirm(`Disconnect ${platform.label}? Workouts already on it are left alone.`)) return;
    void run(async () => {
      await disconnectPlatform(platform.id);
      onChanged();
    });
  };

  return (
    <article className="card">
      <header>
        <h3>{platform.label}</h3>
        <span className="id">{platform.connected ? (platform.account ?? 'connected') : 'not connected'}</span>
      </header>

      {platform.connected ? (
        <>
          <p className="note">
            {platform.synced === 0
              ? 'Nothing pushed yet.'
              : `${platform.synced} workout${platform.synced === 1 ? '' : 's'} on your calendar there.`}{' '}
            Sessions you record on {platform.label} come back here as done.
          </p>
          {platform.last_error && <p className="error">Last sync failed — {platform.last_error}</p>}
          <div className="actions">
            <button className="link" disabled={busy} onClick={sync}>
              Sync now
            </button>
            <button className="link danger" disabled={busy} onClick={disconnect}>
              Disconnect
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="note">
            {platform.credential.help}{' '}
            <a href={platform.credential.help_url} target="_blank" rel="noreferrer">
              Open settings
            </a>
            .
          </p>
          <div className="row">
            <form onSubmit={connect}>
              <input
                type="password"
                autoComplete="off"
                placeholder={platform.credential.label}
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <button className="primary" type="submit" disabled={busy || key.trim() === ''}>
                Connect
              </button>
            </form>
          </div>
        </>
      )}

      {note && <p className="note">{note}</p>}
      {error && <p className="error">{error}</p>}
    </article>
  );
}

/** The integrations panel: one card per platform, connected or not. */
export function Platforms({ onSynced }: { onSynced: () => void }) {
  const [platforms, setPlatforms] = useState<Platform[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    listPlatforms().then(
      (result) => {
        setPlatforms(result.platforms);
        setConfigured(result.configured);
      },
      (failure: Error) => setError(failure.message),
    );
  };

  useEffect(reload, []);

  // Only the first load is silent: after that, saying nothing hides an unconfigured Worker.
  if (platforms === null && error === null) return null;

  return (
    <>
      <p className="note">
        Every workout you create, change or delete here is pushed to the platforms you connect. Sessions you record
        there are read back and marked done.
      </p>

      {!configured && (
        <p className="error">
          Connections are disabled until <code>CREDENTIALS_SECRET</code> is set on the Worker; it is what the keys
          below are encrypted with.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {(platforms ?? []).map((platform) => (
        <PlatformCard key={platform.id} platform={platform} onChanged={reload} onSynced={onSynced} />
      ))}
    </>
  );
}
