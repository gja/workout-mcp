import { Accordion, Section } from './Accordion';

const REPO_URL = 'https://github.com/gja/workout-mcp';

// Octicon `mark-github`, inline rather than fetched: a badge on this page must not call out to anyone.
const GITHUB_MARK =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53' +
  '-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33' +
  '.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67' +
  '-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56' +
  '.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995' +
  ' 7.995 0 0016 8c0-4.42-3.58-8-8-8z';

function Badge({ href, label, value }: { href: string; label: string; value: string }) {
  return (
    <a className="badge" href={href} target="_blank" rel="noreferrer">
      <span className="badge-label">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d={GITHUB_MARK} />
        </svg>
        {label}
      </span>
      <span className="badge-value">{value}</span>
    </a>
  );
}

export function Faq() {
  return (
    <section>
      <h2>FAQ</h2>
      <Accordion>
        <Section group="faq" title="What does it cost?" hint="Nothing">
          <p className="note">
            WorkoutsMCP is free, and it is open source under the MIT licence. There is no paid tier, no trial and no
            card to add — it is small and cheap enough to run that charging for it would cost more than it saves.
          </p>
          <p className="note">
            If you would rather not trust someone else's copy, clone the repo and run your own. Issues and pull
            requests are welcome.
          </p>
          <p className="badges">
            <Badge href={REPO_URL} label="GitHub" value="gja/workout-mcp" />
            <Badge href={`${REPO_URL}/blob/main/LICENSE`} label="licence" value="MIT" />
          </p>
        </Section>

        <Section group="faq" title="What about analytics and data?" hint="I don’t want your data">
          <p className="note">
            No analytics, no tracking pixels, no third-party scripts on this page. Nothing you do here is measured or
            sold.
          </p>
          <p className="note">
            What gets stored is the workouts you plan and whether you marked them done — nothing else about the
            session, and nothing at all about you beyond what signing in and syncing need: your email address, your
            login session, and any training-platform key you connect, which is encrypted at rest. Planned workouts
            only live inside the retention window, 7 days back and 14 ahead, and fall out of the database once they
            leave it.
          </p>
          <p className="note">
            Put plainly: I don't want your data. No heart-rate streams, no GPS tracks, no activity history — there is
            nothing I would do with any of it, and no plans to start collecting it.
          </p>
        </Section>
      </Accordion>
    </section>
  );
}
