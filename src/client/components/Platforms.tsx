import { useEffect, useState } from 'react';
import { disconnectPlatform, getConfig, syncPlatform, type Platform, type SyncReport } from '../api';

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

  const sync = () =>
    void run(async () => {
      const report = await syncPlatform(platform.id);
      if (report.error) throw new Error(report.error);
      setNote(describeSync(report));
      onChanged();
      onSynced();
    });

  const disconnect = () => {
    const warning =
      `Disconnect ${platform.label}? Workouts already on it are left alone, and the ` +
      'access you granted is handed back.';
    if (!confirm(warning)) return;
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
            Sessions you record on {platform.label} come back here as done, usually within about 15 minutes.
          </p>
          {platform.connected_note && <p className="note">{platform.connected_note}</p>}
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
          <p className="note">{platform.connect_help}</p>
          {platform.oauth ? (
            // A full-page navigation, like signing in: the round ends at a callback,
            // so there is no fetch whose answer we could wait on.
            <div className="actions">
              <a className="button primary" href={`/auth/${platform.id}/connect`}>
                Connect {platform.label}
              </a>
            </div>
          ) : (
            <p className="error">
              This server has no {platform.label} OAuth client, so it cannot be connected. Set{' '}
              <code>INTERVALS_CLIENT_ID</code> and <code>INTERVALS_CLIENT_SECRET</code> on the Worker.
            </p>
          )}
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
    getConfig().then(
      (config) => {
        setPlatforms(config.platforms);
        setConfigured(config.credentials_configured);
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
        there are marked done here — as they are analysed, or on the next hourly pass.
      </p>

      {!configured && (
        <p className="error">
          Connections are disabled until <code>CREDENTIALS_SECRET</code> is set on the Worker; it is what the
          access tokens below are encrypted with.
        </p>
      )}
      {error && <p className="error">{error}</p>}

      {(platforms ?? []).map((platform) => (
        <PlatformCard key={platform.id} platform={platform} onChanged={reload} onSynced={onSynced} />
      ))}
    </>
  );
}
