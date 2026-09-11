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
            login session, and any training-platform key you connect, which is encrypted at rest.
          </p>
          <p className="note">
            Put plainly: I don't want your data. No heart-rate streams, no GPS tracks, no activity history — there is
            nothing I would do with any of it, and no plans to start collecting it.
          </p>
          <p className="note">
            The one thing that passes through is a completed workout on its way to your own Google Drive, if you
            turn that on. It is relayed straight across in a single request and never written down here; all that is
            kept is a note that it went, so it is not copied twice.
          </p>
          <p className="note">
            Want it all deleted? Write to <a href="mailto:tejas@gja.in">tejas@gja.in</a> and it goes. The long version,
            including who else sees what, is in <a href="/privacy-policy">the privacy policy</a>.
          </p>
        </Section>

        <Section group="faq" title="How do I analyse my data?" hint="Sync it to your own Workspace Drive">
          <p className="note">
            Connect a Google shared drive under <strong>Setup</strong>, and every completed workout you record on a
            connected training platform is copied into it as the FIT file your watch produced, filed as{' '}
            <code>{'workouts-mcp/intervals.icu/yyyy-mm/yyyy-mm-dd-<id>-<name>.fit'}</code>.
          </p>
          <p className="note">
            Then analyse it there. That is the honest answer to "where are my charts?" — there are none here, because
            keeping the data needed to draw them is exactly what this doesn't do. Once the file is in your Drive it is
            yours: point an assistant at the folder, open it in whatever tool you like, keep it as long as you want.
          </p>
          <p className="note">
            You will need to add this server's service account to the drive as a <strong>Contributor</strong>; the
            panel shows you which address, and it writes a folder there to prove it can before storing anything. Only
            the ones you marked as a race on the platform are copied — an ordinary session stays where it is.
          </p>
          <p className="note">
            It has to be a shared drive, and those are a Google Workspace feature — so on a free Gmail account this
            one is not available. A folder in your own Drive is refused rather than accepted and then quietly failing:
            a service account owns whatever it uploads and has no storage of its own, so there is no quota to charge
            the file to.
          </p>
        </Section>
      </Accordion>
    </section>
  );
}
