# workout-mcp

Plan structured workouts over MCP or a plain REST API, then export them as
Garmin **FIT** workout files. One Cloudflare Worker, a D1 database, and a
static dashboard, all on the free tier. Sign in with Google or Apple; connect
intervals.icu and the plan syncs both ways, with the sessions you record
downloadable as a zip of FIT files to analyse wherever you like.

New here? Start with [docs/deployment.md](docs/deployment.md) to get it
running, then [docs/workouts.md](docs/workouts.md) to write one.

---

## Coding standards

These are the rules this repo is kept to. They are short on purpose; the rest
is in `docs/`.

### Comments are one line

A comment is one line. Two is fine when the point genuinely needs it — a
subtle ordering constraint, an attack it closes off — but that is the ceiling.
If it wants a paragraph, it is not a comment: it is a section in a `docs/`
file, and the code gets a one-liner pointing at it.

```ts
// Read before the delete below, which would take the completion with it.
if (existing) await carryFrom(existing.date, existing.id);
```

### Comments say only non-obvious things

Do not restate the code. A comment earns its line by saying something the
reader cannot get from the code in front of them:

- **why**, when the obvious approach is wrong — an ordering constraint, a
  race, a workaround for someone else's bug;
- **an external contract** — what a wire format, a third-party API or a spec
  requires;
- **a deliberate omission** — something that looks missing but is not.

Delete anything else. `/** The user id. */` above `userId` is noise; a JSDoc
block that repeats the signature is noise. Naming a function well is worth more
than describing it.

### Rationale lives in `docs/`

Design decisions, trade-offs, the history of why something was reversed, and
anything a new contributor needs before touching a module: those go in a
markdown file under `docs/`, and are linked from the module's one-line header
when the link helps. Code review should push a paragraph out of a comment and
into a doc, not the other way round.

### Every doc gets 50-100 words here, and no more

Each file in `docs/` is listed below with a description of **50 to 100 words**.
Not fewer, because a one-line label says nothing useful about which file to
open. Not more, because this README is an index, and an index that grows into
prose stops being read. Adding a doc means adding one entry within that limit;
if an entry needs more room, the extra belongs in the doc itself. Nothing else
goes in this README.

`npm run check:readme` enforces it — every `docs/*.md` must have an entry, and
every entry must be within the limit. CI runs it alongside the typecheck, so a
doc added without an entry, or an entry that has quietly grown, fails the
build.

### Other conventions

- **One door for writes.** Every change to a workout goes through
  `src/plan.ts`, whatever door it came in by. See
  [docs/architecture.md](docs/architecture.md).
- **Validate by resolving.** There is one set of rules for what a workout may
  say, in `src/resolve.ts`, not one per entry point.
- **Errors name the field.** `steps[1].target_pace_km[0]: "nope" is not a valid
  duration`, not `bad request`.
- **TypeScript is strict**, and `tsc --noEmit` runs in CI alongside the tests.
  There is no linter; keep to the style of the file you are in.

---

## The docs

### [docs/deployment.md](docs/deployment.md)

Getting a copy running: creating the D1 database and KV namespace, applying
migrations, and deploying. Lists every secret and what needs it, and explains
why the resource ids are committed rather than hidden. Covers local
development, the two cron schedules and what each pass does, and what the whole
thing costs on Cloudflare's free tier — including why there is no third-party
auth vendor in the stack despite several of them having usable free plans.

### [docs/workouts.md](docs/workouts.md)

The plan format, and the reference you will keep open while writing one. Every
duration and target field, how ranges work and why an open end is written `-`,
how zone ranges become percentage bands and which zone model they assume, and
the two-target rule FIT imposes. Also the workout's own fields, `external_id`
for safe re-syncing, marking a session done as its own verb, and exactly what
gets stored versus what is derived at export time.

### [docs/mcp.md](docs/mcp.md)

Connecting an assistant. Covers the OAuth 2.1 flow a browser-capable client
does on its own, which endpoints Cloudflare's provider library owns and which
one is ours, and the static `wk_` token path for clients that only take a
header. Lists the seven tools and their read-only and destructive annotations,
and explains why no tool result ever carries a URL — an assistant handed a link
passes the link on instead of calling the tool.

### [docs/api.md](docs/api.md)

The full REST surface as one table: sign-in, account and token management,
workout CRUD, completion, training platforms, FIT export, and the MCP tools
over plain HTTP. Explains the `.json` suffix, why `/api/me` hands back the
retention window rather than letting a client compute it, why 401 is answered
before 404 under the API prefixes, and the trade-off in accepting a token as a
query parameter on FIT downloads.

### [docs/library.md](docs/library.md)

The markdown document an assistant reads before it writes you a session: your
sets, how they are built, and how your plan progresses. Explains why it is
context rather than configuration, why the built-in library is served from the
source instead of being copied into every athlete's row on sign-up, and what
`custom: false` is there to tell a caller. Then why MCP can only read it, and
the dashboard and the API are the two ways to change it.

### [docs/auth.md](docs/auth.md)

Sign-in end to end. Setting up Google, Apple and intervals.icu, which is not
OpenID Connect and so has no address to offer, why it needs two registered
callbacks, and why it never joins an account another provider already made.
Then the security detail: why the in-flight sign-in is remembered in both D1
and a cookie and what attack the second half stops, why the login cookie needs
`SameSite=None`, why ID tokens are not signature-checked, and how sessions and
`wk_` API tokens are stored.

### [docs/integrations.md](docs/integrations.md)

Training platforms, of which intervals.icu is the first. Connecting by OAuth,
why the token is encrypted rather than hashed, and what happens when the secret
is rotated away. Then the sync semantics worth knowing before changing any of
it: pushes are upserts keyed on something stable, a platform failure never
fails your write, completions arrive by webhook with an hourly poll behind
them, which event to trust and why the body is never believed for more than
the athlete it names.

### [docs/recordings.md](docs/recordings.md)

Asking for the sessions you actually recorded, over a date range on one
platform, and getting back a signed link that streams them as a ZIP of FIT
files. Why the link carries no credential and lives outside `/api/`, what it
costs to be a four-hour bearer token, and why a fortnight and forty sessions are
the caps — a Worker's subrequest budget, not storage. Then the streaming ZIP
itself, stored rather than deflated to spend no CPU, and the manifest it writes
last.

### [docs/database.md](docs/database.md)

D1 and the schema. How migrations are written and tested, and why the steps are
a TEXT column with a `json_valid` check rather than a JSON type SQLite does not
have. Then the retention window: 7 days back and 14 ahead, enforced on writes
and on every read, with a day of slack for timezones. Explains why nothing
sweeps old workouts any more, and the write-ordering rules a change here must
keep.

### [docs/architecture.md](docs/architecture.md)

The module map and how a request moves through it: the OAuth provider wrapping
everything, the routing table, and `withUser` as the single place a credential
becomes an athlete. Explains why every write funnels through `src/plan.ts`, how
the platform layer is kept ignorant of any particular platform, and the small
router's rules. Read this before adding a route, a module, or a second training
platform.

### [docs/fit.md](docs/fit.md)

What you need to know before touching `src/fit.ts`. The Garmin SDK writes
parent fields only, so the encoder applies the profile's scaling itself. FIT
stores steps flat, so nested repeats are flattened with the repeat emitted
after its children. An open range end is an absent field, not a zero. And the
encoder's 500 MB buffer request has to be clamped or production workerd refuses
it outright.

### [docs/testing.md](docs/testing.md)

How the suite is put together and why. Tests run inside `workerd`, on the same
runtime that serves production, which is the only place some of the encoder
bugs reproduce at all. FIT files are asserted by decoding them again with
Garmin's own decoder. Google, Apple and intervals.icu are stood in for by an
auxiliary Worker that Miniflare routes outbound traffic to, so the real sign-in
path runs offline. Lists what each suite covers, and how an archive is read
back by a ZIP reader written the way a real one works.

---

## Licence

MIT — see [LICENSE](LICENSE).

This project depends on [`@garmin/fitsdk`](https://github.com/garmin/fit-javascript-sdk),
which Garmin ships under the **Flexible and Interoperable Data Transfer (FIT)
Protocol License**, not an OSI licence. Nothing from the SDK is vendored here —
it is an ordinary npm dependency — but if you redistribute a build, read
Garmin's terms first.
