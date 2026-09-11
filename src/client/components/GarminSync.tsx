import { useCallback, useEffect, useState } from 'react';
import {
  disconnectGarmin,
  getGarminStatus,
  setGarminAutoSync,
  syncWorkouts,
  type GarminStatus,
  type SyncAction,
  type SyncReport,
} from '../api';

/**
 * The actions worth naming in a summary, and what to call them.
 *
 * `unchanged` is left out on purpose: on a settled plan it is every workout,
 * and "48 unchanged" is not news. It shows up in the per-workout list below
 * for anyone who wants to check.
 */
const ACTION_LABELS: Partial<Record<SyncAction, string>> = {
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
function summarize(report: SyncReport): string {
  const parts = Object.entries(ACTION_LABELS)
    .filter(([action]) => report.counts[action as SyncAction] > 0)
    .map(([action, label]) => `${report.counts[action as SyncAction]} ${label}`);
  return parts.join(' · ');
}

/** Only the workouts a reader needs to see: what changed, and what went wrong. */
const notable = (report: SyncReport) =>
  report.workouts.filter((entry) => entry.action !== 'unchanged' || (entry.notes?.length ?? 0) > 0);

function Report({ report, onCompleted }: { report: SyncReport; onCompleted: () => void }) {
  const changed = summarize(report);
  const rows = notable(report);

  // A session ticked off from Garmin changes the calendar behind this panel,
  // so the plan above has to be told rather than left showing it as planned.
  useEffect(() => {
    if (report.completed.length > 0) onCompleted();
  }, [report, onCompleted]);

  return (
    <>
      <p className="note">
        {report.dry_run ? 'Preview — nothing was sent. ' : ''}
        {changed || (report.dry_run ? 'Nothing would change.' : 'Everything was already up to date.')}
      </p>

      {report.completed.length > 0 && (
        <>
          <p className="done-note">
            {report.completed.length} session{report.completed.length === 1 ? '' : 's'} ticked off from what you
            recorded on Garmin.
          </p>
          <pre>
            {report.completed
              .map((entry) => `${entry.date}  ${entry.name ?? entry.id} — done (${entry.activity})`)
              .join('\n')}
          </pre>
        </>
      )}
      {report.completed_note && <p className="note">{report.completed_note}</p>}

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

type Mode = 'sync' | 'preview' | 'resend';

/**
 * Connecting and syncing a Garmin account.
 *
 * Connecting is a full-page navigation out to Garmin's consent screen and back
 * — the same shape as signing in, and for the same reason: only Garmin can ask
 * the athlete to approve it. The callback lands back here with
 * `?garmin_connected` or `?garmin_error`, which is what the two `useState`
 * initialisers below read off the URL.
 *
 * Renders nothing when the deployment has no Garmin credentials, so a
 * self-hosted install that has not set them up does not show a dead panel —
 * but a *failure* to find that out is shown rather than swallowed, because a
 * panel that silently vanishes on a failed request looks identical to one that
 * was never configured.
 *
 * `onWorkoutsChanged` is called when a sync ticks a session off from Garmin:
 * that changes the plan the calendar above is drawing, and this is the only
 * thing on the page that knows it happened.
 */
export function GarminSync({ onWorkoutsChanged }: { onWorkoutsChanged: () => void }) {
  const [status, setStatus] = useState<GarminStatus | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [busy, setBusy] = useState<Mode | null>(null);
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('garmin_error'),
  );
  const [justConnected] = useState(() => new URLSearchParams(location.search).has('garmin_connected'));

  const reload = useCallback(() => {
    getGarminStatus().then(
      (found) => {
        setStatus(found);
        setUnreachable(null);
      },
      (failure: Error) => setUnreachable(failure.message),
    );
  }, []);

  useEffect(reload, [reload]);

  const run = async (mode: Mode) => {
    if (mode === 'resend' && !confirm('Re-send every workout to Garmin, even the ones it already has unchanged?')) {
      return;
    }
    setBusy(mode);
    setError(null);
    try {
      const outcome = await syncWorkouts({ dry_run: mode === 'preview', force: mode === 'resend' });
      // This card is Garmin's, so it shows Garmin's half of a sync that
      // covers every linked platform. A second platform gets its own card.
      const garmin = outcome.providers.find((entry) => entry.provider === 'garmin');
      setReport(garmin?.connected ? garmin.report : null);
      if (garmin && !garmin.connected) setError(garmin.note);
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

  // A failed status call is reported, not hidden: it is the one case where
  // rendering nothing would be a lie about what this deployment supports.
  if (unreachable) {
    return (
      <section>
        <h2>Garmin Connect</h2>
        <p className="error">Could not read the Garmin connection: {unreachable}</p>
      </section>
    );
  }

  // Still loading, or this server has no Garmin credentials at all.
  if (status === null || !status.configured) return null;

  return (
    <section>
      <h2>Garmin Connect</h2>
      <p className="note">
        Push planned workouts onto your Garmin calendar, where your watch picks them up on its next sync — and take
        back what you actually did, so a session you have run is ticked off here without you saying so twice.
      </p>

      {error && <p className="error">{error}</p>}

      {!status.connected ? (
        <article className="card">
          <h3>Not connected</h3>
          <p className="note">
            Connecting opens Garmin's own consent screen. Planned workouts are written to your calendar, and the
            activities you record are read back — only to tick off the sessions they account for.
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

          {report && <Report report={report} onCompleted={onWorkoutsChanged} />}

          <div className="actions">
            {/*
              A normal sync only touches what changed here, so a session
              deleted from the Garmin app — which changed nothing here — is
              invisible to it. Re-sending is how that gets noticed and put
              back, which is why this is reachable rather than a flag only the
              API has.
            */}
            <button className="link" disabled={busy !== null} onClick={() => void run('resend')}>
              {busy === 'resend' ? 'Re-sending…' : 'Re-send everything'}
            </button>
            <button className="link danger" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </div>
        </article>
      )}
    </section>
  );
}
