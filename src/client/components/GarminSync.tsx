import { useCallback, useEffect, useState } from 'react';
import {
  disconnectGarmin,
  getGarminStatus,
  setGarminAutoSync,
  syncGarmin,
  type GarminStatus,
  type GarminSyncAction,
  type GarminSyncReport,
} from '../api';

/**
 * The actions worth naming in a summary, and what to call them.
 *
 * `unchanged` is left out on purpose: on a settled plan it is every workout,
 * and "48 unchanged" is not news. It shows up in the per-workout list below
 * for anyone who wants to check.
 */
const ACTION_LABELS: Partial<Record<GarminSyncAction, string>> = {
  created: 'added to the calendar',
  updated: 'updated',
  rescheduled: 'moved',
  removed: 'removed from the calendar',
  untracked: 'aged out, left on Garmin',
  skipped: 'not reached this run',
  failed: 'failed',
};

const shortDate = (value: string | null | undefined): string =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never';

/** "3 added to the calendar · 1 moved". Empty when a run changed nothing. */
function summarize(report: GarminSyncReport): string {
  const parts = Object.entries(ACTION_LABELS)
    .filter(([action]) => report.counts[action as GarminSyncAction] > 0)
    .map(([action, label]) => `${report.counts[action as GarminSyncAction]} ${label}`);
  return parts.join(' · ');
}

/** Only the workouts a reader needs to see: what changed, and what went wrong. */
const notable = (report: GarminSyncReport) =>
  report.workouts.filter((entry) => entry.action !== 'unchanged' || (entry.notes?.length ?? 0) > 0);

function Report({ report }: { report: GarminSyncReport }) {
  const changed = summarize(report);
  const rows = notable(report);

  return (
    <>
      <p className="note">
        {report.dry_run ? 'Preview — nothing was sent. ' : ''}
        {changed || (report.dry_run ? 'Nothing would change.' : 'Everything was already up to date.')}
      </p>

      {report.error && <p className="error">{report.error}</p>}
      {report.truncated && (
        <p className="note">
          This run hit its call budget before finishing. Sync again to pick up where it stopped — nothing was lost.
        </p>
      )}

      {rows.length > 0 && (
        <pre>
          {rows
            .map((entry) => {
              const head = `${entry.date}  ${entry.name ?? entry.id} — ${ACTION_LABELS[entry.action] ?? entry.action}`;
              // Notes and errors are indented under the workout they belong
              // to, so a long list still reads as one line per workout.
              const detail = [...(entry.error ? [entry.error] : []), ...(entry.notes ?? [])];
              return [head, ...detail.map((line) => `    ${line}`)].join('\n');
            })
            .join('\n')}
        </pre>
      )}
    </>
  );
}

/**
 * Connecting and syncing a Garmin account.
 *
 * Connecting is a full-page navigation out to Garmin's consent screen and back
 * — the same shape as signing in, and for the same reason: only Garmin can ask
 * the athlete to approve it. The callback lands back here with
 * `?garmin_connected` or `?garmin_error`, which is what the first `useState`
 * below is reading.
 *
 * Renders nothing when the deployment has no Garmin credentials, so a
 * self-hosted install that has not set them up does not show a dead panel.
 */
export function GarminSync() {
  const [status, setStatus] = useState<GarminStatus | null>(null);
  const [report, setReport] = useState<GarminSyncReport | null>(null);
  const [busy, setBusy] = useState<'sync' | 'preview' | null>(null);
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(location.search);
    return params.get('garmin_error');
  });
  const [justConnected] = useState(() => new URLSearchParams(location.search).has('garmin_connected'));

  const reload = useCallback(() => {
    getGarminStatus().then(setStatus, (failure: Error) => {
      setStatus({ configured: false, connected: false });
      setError(failure.message);
    });
  }, []);

  useEffect(reload, [reload]);

  const run = async (mode: 'sync' | 'preview') => {
    setBusy(mode);
    setError(null);
    try {
      setReport(await syncGarmin(mode === 'preview' ? { dry_run: true } : {}));
      reload();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async (enabled: boolean) => {
    setError(null);
    try {
      setStatus(await setGarminAutoSync(enabled));
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect Garmin? Workouts already on the calendar stay there; nothing new will be pushed.')) return;
    setError(null);
    try {
      await disconnectGarmin();
      setReport(null);
      reload();
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  if (status === null || !status.configured) return null;

  return (
    <section>
      <h2>Garmin Connect</h2>
      <p className="note">
        Push planned workouts onto your Garmin calendar, where your watch picks them up on its next sync.
      </p>

      {error && <p className="error">{error}</p>}

      {!status.connected ? (
        <article className="card">
          <h3>Not connected</h3>
          <p className="note">
            Connecting opens Garmin's own consent screen. Nothing is read from your Garmin account — this only writes
            planned workouts to your calendar.
          </p>
          <div className="row">
            {/* A plain link, not a fetch: the browser has to leave for Garmin. */}
            <a className="button" href="/garmin/connect">
              Connect Garmin
            </a>
          </div>
        </article>
      ) : (
        <article className="card">
          <header>
            <h3>Connected</h3>
            {status.garmin_user_id && <span className="id">{status.garmin_user_id.slice(0, 12)}…</span>}
          </header>

          {justConnected && !report && <p className="note">Account linked. Sync now to push your plan across.</p>}

          <p className="note">
            Last synced {shortDate(status.last_sync_at)} · {status.synced_workouts ?? 0} workout
            {status.synced_workouts === 1 ? '' : 's'} tracked
          </p>
          {status.last_sync_error && <p className="error">Last sync: {status.last_sync_error}</p>}

          <p className="note">
            <label>
              <input
                type="checkbox"
                checked={status.auto_sync ?? false}
                onChange={(event) => void toggleAuto(event.target.checked)}
              />{' '}
              Sync automatically each night
            </label>
          </p>

          <div className="row">
            <button className="primary" disabled={busy !== null} onClick={() => void run('sync')}>
              {busy === 'sync' ? 'Syncing…' : 'Sync now'}
            </button>
            <button disabled={busy !== null} onClick={() => void run('preview')}>
              {busy === 'preview' ? 'Checking…' : 'Preview'}
            </button>
          </div>

          {report && <Report report={report} />}

          <div className="actions">
            <button className="link danger" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
