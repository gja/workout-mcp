import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

// The policy describes what the code in this repo actually does; if the two ever
// disagree, the code is the bug. Bump this when the answer changes.
const UPDATED = '11 September 2026';

const REPO_URL = 'https://github.com/gja/workout-mcp';

function Policy() {
  return (
    <main className="policy">
      <header className="masthead">
        <div>
          <h1>Privacy policy</h1>
          <p className="sub">
            What WorkoutsMCP stores, who else sees it, and how to get rid of it. Last updated {UPDATED}.
          </p>
        </div>
      </header>

      <p className="note">
        This covers the hosted instance at <strong>workouts-mcp.com</strong>, run as a free, open-source side project
        rather than a company. The short version is the same as the one on the front page: I don't want your data. What
        is stored is what planning a workout and syncing it somewhere needs, and nothing else.
      </p>

      <h2>What is stored</h2>
      <ul className="note">
        <li>
          <strong>Your account.</strong> The provider you signed in with (Google or Apple), that provider's stable id
          for you, your email address, and when the account was created and last used. Apple's private relay addresses
          are kept as-is — if that is what Apple sends, that is all I have.
        </li>
        <li>
          <strong>Your sign-in session.</strong> One httpOnly cookie, stored server-side as a hash rather than the
          cookie itself, with an expiry. In-flight sign-ins are held for ten minutes and then swept.
        </li>
        <li>
          <strong>Your workouts.</strong> The plan you made — date, name, sport, notes, and the steps — and whether you
          marked it done. No heart-rate streams, no GPS tracks, no activity history, no files from your watch.
        </li>
        <li>
          <strong>API tokens and connected apps.</strong> Tokens you create are stored as a hash plus the first few
          characters, so the dashboard can show you which is which; the full token is shown once and never again.
          Apps you connect over OAuth have their grant recorded so you can revoke them.
        </li>
        <li>
          <strong>Training-platform connections.</strong> If you connect intervals.icu, its API key is stored encrypted
          at rest, along with the account name it belongs to and the error from the last failed sync. Without the
          encryption key configured, a connection is refused rather than stored in the clear.
        </li>
      </ul>

      <h2>What is not</h2>
      <p className="note">
        No analytics, no tracking pixels, no advertising, no third-party scripts on any page here — the GitHub logo in
        the FAQ is inlined so that even a badge does not call out to anyone. Nothing is sold, rented or shared for
        marketing, and there is no profiling or automated decision-making. Your data is not used to train anything.
      </p>

      <h2>Who else sees it</h2>
      <ul className="note">
        <li>
          <strong>Cloudflare</strong> hosts the site, the database and the session store, and sees the request traffic
          that reaches it.
        </li>
        <li>
          <strong>Google or Apple</strong>, whichever you sign in with, tell me who you are; what they log about the
          sign-in is between you and them.
        </li>
        <li>
          <strong>intervals.icu</strong>, and only if you connect it: workouts you sync are pushed there, and
          completions are read back hourly.
        </li>
        <li>
          <strong>The MCP client you connect</strong> — Claude, or whatever else you authorize — can read and write the
          workouts in your window, because that is the point of it. Revoke it and that stops.
        </li>
      </ul>
      <p className="note">
        Beyond that, data is disclosed only if the law actually requires it. There is no other recipient and no sale.
      </p>

      <h2>How long it is kept</h2>
      <p className="note">
        Workouts are only readable inside a rolling window — 7 days back and 14 days ahead. A session that ages out of
        that window stops being visible and is not deleted: nothing here throws away training history you did not ask
        it to. Expired login sessions, abandoned sign-ins and stale OAuth grants are swept nightly. Everything else
        stays until you delete it or ask for the account to go.
      </p>

      <h2>What you can do about it</h2>
      <ul className="note">
        <li>Delete any workout from the dashboard, or through your MCP client.</li>
        <li>Revoke an API token, or a connected app, from the Setup section of the dashboard.</li>
        <li>Disconnect a training platform, which deletes the stored credential.</li>
        <li>
          Ask for the account itself — identity row, tokens, sessions and every workout — to be deleted, by opening an
          issue at <a href={`${REPO_URL}/issues`}>{REPO_URL.replace('https://', '')}</a>. A copy of what is held can be
          asked for the same way.
        </li>
        <li>
          Or skip trusting someone else's copy entirely: it is MIT-licensed, so you can{' '}
          <a href={REPO_URL}>run your own</a>, on your own Cloudflare account, where none of the above involves me.
        </li>
      </ul>

      <h2>Changes and contact</h2>
      <p className="note">
        If this policy changes, the date at the top changes with it, and the diff is public in the repository's
        history. Questions, corrections and complaints go to <a href={`${REPO_URL}/issues`}>the issue tracker</a>.
      </p>

      <p className="note">
        <a href="/">Back to the dashboard</a>
      </p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Policy />
  </StrictMode>,
);
