import { Accordion, Section } from './Accordion';
import { CopyButton } from './CopyButton';

const REPO_URL = 'https://github.com/gja/workout-mcp';

// Octicon `mark-github`, inline rather than fetched: a badge on this page must not call out to anyone.
const GITHUB_MARK =
  'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53' +
  '-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33' +
  '.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.07-.2-.36-1.02.08-2.12 0 0 .67' +
  '-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56' +
  '.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995' +
  ' 7.995 0 0016 8c0-4.42-3.58-8-8-8z';

const STARTER_PROMPT = 'Run the workouts-mcp-onboarding-wizard skill from the Workouts MCP server.';

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
            is what actually runs on the wrist. It pulls the workout off the intervals.icu calendar and plays it
            through the intervals, so you follow the session instead of remembering it. intervals.icu has its own app
            that will do this too, and it is free — but Watchletic is about $2, and for the features you get it is
            worth every cent of it.
          </p>
          <p className="note">
            Watchletic is Apple Watch only, though. On a Garmin or anything else, use intervals.icu directly — the
            planned session goes to your watch from there.
          </p>
        </Section>

        <Section group="faq" title="Is there an iPhone app?" hint="Ask for an invite">
          <p className="note">
            Yes, and it is the way in if your watch is an Apple Watch. It schedules the plan through Apple's own
            Workout app — no intervals.icu and no Watchletic in the middle — and carries the recorded session back
            here, so the stats show up beside what you planned. What it does and why is in{' '}
            <a href={`${REPO_URL}/blob/main/docs/ios.md`} target="_blank" rel="noreferrer">
              docs/ios.md
            </a>
            , and the source is in{' '}
            <a href={`${REPO_URL}/tree/main/ios`} target="_blank" rel="noreferrer">
              ios/
            </a>{' '}
            like everything else.
          </p>
          <p className="note">
            It is not on the App Store yet — builds go out through TestFlight, one invite at a time. Write to{' '}
            <a href="mailto:tejas@gja.in">tejas@gja.in</a> with the email address on your Apple Account and you'll get
            one.
          </p>
        </Section>

        <Section group="faq" title="Can you give me a prompt to get started with Claude?" hint="One line">
          <p className="note">
            Once the connector is added, paste this into a fresh Claude conversation. The interview lives on this
            server, so the line only has to name it — Claude fetches the rest and runs it.
          </p>
          <pre className="snippet prose">{STARTER_PROMPT}</pre>
          <div className="actions">
            <CopyButton label="Copy prompt" text={STARTER_PROMPT} />
          </div>
          <p className="note">
            It reads whatever you have already written before it asks anything, then works through your sports and
            your goal, how much of the planning you want done for you, the week you actually have, your numbers per
            sport, and anything that constrains the plan. The answers are saved as your zones, your scheduling
            instructions and your current plan, so the next conversation starts from them instead of from questions.
            It ends by offering the next step: a week of workouts written there and then, or a scheduled task that
            reviews last week and places the coming one every Sunday.
          </p>
          <p className="note">
            Some clients offer the same interview as a prompt you pick rather than something you type, under a name
            like <code>/mcp__Workouts_MCP__getting-started</code>. The prefix is whatever you called this connector,
            so look for <code>getting-started</code> in the picker. Either door runs the same thing.
          </p>
        </Section>

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
            What gets stored is the workouts you plan, whether you marked them done, and — once your training platform
            says you recorded the session — some basic stats about how it went. Nothing at all about you beyond what
            signing in and syncing need: your email address, your login session, and any training-platform key you
            connect, which is encrypted at rest.
          </p>
          <p className="note">
            Basic means totals and averages: how long, how far, average and maximum heart rate, a row per lap with its
            pace and cadence, and each lap's four quarters so a fade inside a rep is visible. That is enough to say
            whether you actually did the session. It is <em>not</em> second-by-second data — no heart-rate stream, no
            GPS track, nothing about where you were. The file is read once, the numbers are kept and the file is
            thrown away.
          </p>
          <p className="note">
            Exactly which figures, with nothing left out, is{' '}
            <a href={`${REPO_URL}/blob/main/src/stats.ts`} target="_blank" rel="noreferrer">
              src/stats.ts
            </a>
            , and the reasoning behind it is in{' '}
            <a href={`${REPO_URL}/blob/main/docs/stats.md`} target="_blank" rel="noreferrer">
              docs/stats.md
            </a>
            . Read them rather than taking my word for it.
          </p>
          <p className="note">
            Put plainly: I don't want your data. Beyond those numbers there is no activity history and no files from
            your watch — there is nothing I would do with any of it, and no plans to start collecting it.
          </p>
          <p className="note">
            The recordings themselves only pass through. When you ask for them they are relayed straight from your
            training platform to your download in a single request, and never written down here — not the file, not a
            note that you asked.
          </p>
          <p className="note">
            Want it all deleted? Write to <a href="mailto:tejas@gja.in">tejas@gja.in</a> and it goes. The long version,
            including who else sees what, is in <a href="/privacy-policy">the privacy policy</a>.
          </p>
        </Section>

        <Section group="faq" title="How do I analyse my data?" hint="Download what you recorded">
          <p className="note">
            For a session you planned here, most of the answer is already waiting: ask your assistant how last week
            went and it reads the stats stored against each workout — lap by lap, against the targets you planned —
            without downloading anything. The calendar shows the same thing: open a session you have done and every
            lap is there beside what it was aimed at.
          </p>
          <p className="note">
            For everything else, ask it for the sessions you recorded over a date range and it hands you a link;
            follow it and you get a <code>.zip</code> of the FIT files your watch produced, one per session, plus a{' '}
            <code>manifest.json</code> saying what is in it. Up to a fortnight at a time — for longer, ask twice.
          </p>
          <p className="note">
            Then analyse them there. That is the honest answer to "where are my charts?" — there are none here,
            because keeping the data needed to draw them is exactly what this doesn't do. The files are yours the
            moment you have them: open them in whatever tool you like, keep them as long as you want.
          </p>
          <p className="note">
            Nothing is stored to make this work. The link carries what you asked for and a signature saying it was us
            who wrote it, the files are fetched from your training platform when you follow it, and it stops working
            after four hours. Which also means: while it works, anyone holding the link can use it, so treat it like
            the download it is.
          </p>
        </Section>

        <Section group="faq" title="Can I take my context with me?" hint="Export context">
          <p className="note">
            Yes, and without asking anyone. Open <em>Setup → Context</em> and press <em>Export context</em>: you get a{' '}
            <code>backup-context.zip</code> holding one markdown file per document — your workout library, your
            current plan, your scheduling instructions, your zones — plus a <code>manifest.json</code> saying which of
            them you wrote and when you last touched each one.
          </p>
          <p className="note">
            Those four documents are the part of this that is genuinely yours: the workouts can be rebuilt from a
            plan, but what you have told an assistant about how you train cannot. Keep a copy somewhere that isn't
            here. Markdown in a zip reads fine in any editor, and it will still read fine if this site stops existing.
          </p>
        </Section>
      </Accordion>
    </section>
  );
}
