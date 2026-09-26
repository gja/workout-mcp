import { Accordion, Section } from './Accordion';
import { CopyButton } from './CopyButton';

export const REPO_URL = 'https://github.com/gja/workout-mcp';

// Octicon `mark-github`, inline rather than fetched: a badge on this page must not call out to anyone.
const GITHUB_MARK =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53' +
  '-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33' +
  '.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67' +
  '-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56' +
  '.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995' +
  ' 7.995 0 0016 8c0-4.42-3.58-8-8-8z';

/** Plain English on purpose: the connector's own tool and skill are named for onboarding, so this reaches them. */
export const STARTER_PROMPT = 'Get me onboarded with WorkoutsMCP';

/** What the dashboard's *Get started with Claude* opens. */
export const STARTER_SECTION_ID = 'faq-getting-started';

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
        <Section group="faq" title="I train with an Apple Watch" hint="Two ways">
          <p className="note">
            The one I would pick: plan here, let it sync to{' '}
            <a href="https://intervals.icu" target="_blank" rel="noreferrer">
              intervals.icu
            </a>
            , and follow the session with{' '}
            <a href="https://www.watchletic.com" target="_blank" rel="noreferrer">
              Watchletic
            </a>
            , which plays the workout through its intervals so you follow it instead of remembering it. intervals.icu's
            own app does the same and is free — but Watchletic is about $2, and worth every cent of it.
          </p>
          <p className="note">
            Or use nothing but Apple's own apps: the WorkoutsMCP{' '}
            <a href={`${REPO_URL}/blob/main/docs/ios.md`} target="_blank" rel="noreferrer">
              iPhone app
            </a>{' '}
            schedules the plan into the Workout app and brings the recorded session back here. It is free, and not on
            the App Store yet — write to <a href="mailto:tejas@gja.in">tejas@gja.in</a> with the email address on your
            Apple Account for a TestFlight invite.
          </p>
        </Section>

        <Section group="faq" title="I train with a Garmin or another fitness watch" hint="Via intervals.icu">
          <p className="note">
            Through{' '}
            <a href="https://intervals.icu" target="_blank" rel="noreferrer">
              intervals.icu
            </a>
            . Connect it under <em>Setup → Integrations</em> and every session you plan lands on its calendar; connect
            Garmin Connect — or Coros, Polar, Suunto, Wahoo — at their end, and the workout goes down to the watch and
            the file it records comes back, marked done here with its stats. Nothing to install: the watch's own
            workout screen runs it.
          </p>
        </Section>

        <Section group="faq" title="I train with a Wear OS watch" hint="Via intervals.icu">
          <p className="note">
            The Apple Watch road, on Google's side of the fence:{' '}
            <a href="https://intervals.icu" target="_blank" rel="noreferrer">
              intervals.icu
            </a>{' '}
            connects to what Google Fit holds, and{' '}
            <a href="https://www.watchletic.com" target="_blank" rel="noreferrer">
              Watchletic
            </a>{' '}
            runs on Wear OS too.
          </p>
        </Section>

        <Section group="faq" title="Anything else, or nothing on my wrist" hint="Via intervals.icu">
          <p className="note">
            intervals.icu takes a file from almost anywhere, and its own app will play a planned session on a phone.
            With no watch at all the plan is still on the calendar here: read the session off the screen and mark it
            done.
          </p>
        </Section>

        <Section group="faq" title="What is your training tech stack?" hint="Four pieces">
          <p className="note">
            Four pieces, each doing one job.{' '}
            <a href="https://claude.ai" target="_blank" rel="noreferrer">
              Claude
            </a>{' '}
            is the coach: it knows what week of the block you are in, what you did yesterday and how it went, and it
            writes the session.
          </p>
          <p className="note">
            <a href={REPO_URL} target="_blank" rel="noreferrer">
              WorkoutsMCP
            </a>{' '}
            — this — is how Claude writes it down. It turns "four by eight at threshold, three easy between" into a
            real structured workout, keeps the plan somewhere you can see it, and syncs it out.
          </p>
          <p className="note">
            <a href="https://intervals.icu" target="_blank" rel="noreferrer">
              intervals.icu
            </a>{' '}
            is the calendar and the analysis. Planned sessions land on it, recorded ones come back, and your
            thresholds live there so a target written as "threshold" means the right number for you today.
          </p>
          <p className="note">
            <a href="https://www.watchletic.com" target="_blank" rel="noreferrer">
              Watchletic
            </a>{' '}
            runs it on the wrist, on an Apple Watch or a Wear OS one; on a Garmin the watch's own workout screen does
            that job. On an Apple Watch the{' '}
            <a href={`${REPO_URL}/tree/main/ios`} target="_blank" rel="noreferrer">
              iPhone app
            </a>{' '}
            replaces the last two.
          </p>
        </Section>

        <Section
          group="faq"
          id={STARTER_SECTION_ID}
          title="Can you give me a prompt to get started with Claude?"
          hint="One line"
        >
          <p className="note">Once the connector is added, paste this into a fresh Claude conversation.</p>
          <pre className="snippet prose">{STARTER_PROMPT}</pre>
          <div className="actions">
            <CopyButton label="Copy prompt" text={STARTER_PROMPT} />
          </div>
        </Section>

        <Section group="faq" title="What does it cost?" hint="Nothing">
          <p className="note">
            Nothing: free, open source under the MIT licence, no paid tier and no card to add. It is small and cheap
            enough to run that charging for it would cost more than it saves. If you would rather not trust someone
            else's copy, clone the repo and run your own — issues and pull requests welcome.
          </p>
          <p className="badges">
            <Badge href={REPO_URL} label="GitHub" value="gja/workout-mcp" />
            <Badge href={`${REPO_URL}/blob/main/LICENSE`} label="licence" value="MIT" />
          </p>
        </Section>

        <Section group="faq" title="What about analytics and data?" hint="I don’t want your data">
          <p className="note">
            No analytics, no tracking pixels, no third-party scripts on this page. What gets stored is the workouts
            you plan, whether you marked them done, and — once your training platform says you recorded the session —
            basic stats about how it went. Nothing about you beyond what signing in and syncing need: your email
            address, your login session, and any training-platform key you connect, encrypted at rest.
          </p>
          <p className="note">
            Basic means totals and averages, a row per lap with its pace and cadence, and each lap's four quarters so
            a fade inside a rep is visible — enough to say whether you actually did the session. It is <em>not</em>{' '}
            second-by-second data: no heart-rate stream, no GPS track, nothing about where you were. The file is read
            once, the numbers are kept and the file is thrown away. Exactly which figures is{' '}
            <a href={`${REPO_URL}/blob/main/src/stats.ts`} target="_blank" rel="noreferrer">
              src/stats.ts
            </a>
            , and the reasoning is in{' '}
            <a href={`${REPO_URL}/blob/main/docs/stats.md`} target="_blank" rel="noreferrer">
              docs/stats.md
            </a>
            .
          </p>
          <p className="note">
            Put plainly: I don't want your data. Recordings you download only pass through — relayed from your
            training platform to you in a single request, and never written down here. Want it all deleted? Write to{' '}
            <a href="mailto:tejas@gja.in">tejas@gja.in</a> and it goes. The long version is in{' '}
            <a href="/privacy-policy">the privacy policy</a>.
          </p>
        </Section>

        <Section group="faq" title="How do I analyse my data?" hint="Download what you recorded">
          <p className="note">
            Ask your assistant how last week went: it reads the stats stored against each workout, lap by lap against
            the targets you planned. The calendar shows the same — open a session you have done.
          </p>
          <p className="note">
            For everything else, ask for the sessions you recorded over a date range and it hands you a link: a{' '}
            <code>.zip</code> of the FIT files your watch produced, one per session, plus a <code>manifest.json</code>
            . Up to a fortnight at a time. Analyse them wherever you like — there are no charts here, because keeping
            the data needed to draw them is exactly what this doesn't do.
          </p>
          <p className="note">
            The link stores nothing: it carries what you asked for and a signature saying it was us who wrote it, the
            files are fetched when you follow it, and it stops working after four hours. Anyone holding it can use it
            until then, so treat it like the download it is.
          </p>
        </Section>

        <Section group="faq" title="Can I take my context with me?" hint="Export context">
          <p className="note">
            Yes, and without asking anyone. Open <em>Setup → Context</em> and press <em>Export context</em>: a{' '}
            <code>backup-context.zip</code> holding one markdown file per document — your workout library, current
            plan, scheduling instructions and zones — plus a <code>manifest.json</code> saying when you last touched
            each one.
          </p>
          <p className="note">
            Those four documents are the part of this that is genuinely yours: the workouts can be rebuilt from a
            plan, what you have told an assistant about how you train cannot. Keep a copy somewhere that isn't here.
          </p>
        </Section>
      </Accordion>
    </section>
  );
}
