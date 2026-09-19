<img src="public/logo.svg" alt="" width="72" align="right">

# workout-mcp

**Plan, execute and analyze your workouts with AI.** Over MCP or a plain REST API: the plan
goes out to a watch as a Garmin **FIT** workout file, and the session recorded against it
comes back as numbers. One Cloudflare Worker, a D1 database and a static dashboard, all on
the free tier. Sign in with Google or Apple; connect intervals.icu and the plan syncs both
ways.

Running at **[workouts-mcp.com](https://workouts-mcp.com)**, with an iPhone app in
[`ios/`](ios/) that sends the plan to Apple Fitness through WorkoutKit and the recorded
session back as a FIT file.

MIT licensed, and **nothing secret is checked in**: the server's credentials are Wrangler
secrets (see [docs/deployment.md](docs/deployment.md)); the app holds none at all, because
it registers itself as a public OAuth client and keeps what it gets in the keychain.

New here? Start with [docs/deployment.md](docs/deployment.md) to get it running, then
[docs/workouts.md](docs/workouts.md) to write one.

---

## Coding standards

**Comments are one line.** Two when the point genuinely needs it. If it wants a paragraph
it is not a comment — it is a section in `docs/`, and the code gets a one-liner pointing at
it.

**A comment earns its line by saying what the code cannot**: a *why* where the obvious
approach is wrong, an *external contract* a wire format or API imposes, or a *deliberate
omission*. Delete everything else. Naming a function well beats describing it.

**Rationale lives in `docs/`.** Review should push a paragraph out of a comment and into a
doc, never the other way round.

**Every doc gets a 25-50 word entry below, and no more.** `npm run check:readme` enforces
it; CI runs it beside the typecheck. Nothing else goes in this README.

**No N+1 — not in SQL, and not over HTTP.** A loop issuing one query or one request per
item is a bug, not a shape to live with. Read the whole set in one statement; give clients
a route that takes the whole set. Fanning out in parallel is not a fix — it hides the
latency and still pays for every call. Fix it where you find it.

**One door for writes.** Every change to a workout goes through `src/plan.ts`, whatever
door it came in by. See [docs/architecture.md](docs/architecture.md).

**Validate by resolving.** One set of rules for what a workout may say, in
`src/resolve.ts`, not one per entry point.

**Errors name the field.** `steps[1].target_pace_km[0]: "nope" is not a valid duration`,
not `bad request`.

**TypeScript is strict**, and `tsc --noEmit` runs in CI. There is no linter; keep to the
style of the file you are in.

---

## The docs

### [docs/deployment.md](docs/deployment.md)

Getting a copy running: the D1 database, the KV namespace, migrations, secrets and what
needs each. Covers local development, the three cron schedules, and what the whole thing
costs on Cloudflare's free tier.

### [docs/workouts.md](docs/workouts.md)

The plan format, and the reference to keep open while writing one. Every duration and
target field, how ranges work, how zone ranges become percentage bands, the two-target rule
FIT imposes, and marking a session done and saying how it went.

### [docs/mcp.md](docs/mcp.md)

Connecting an assistant: the OAuth 2.1 flow, the static `wk_` token path, every tool and
its annotations, the two protocol eras and how one header decides between them, and which
JSON-RPC failures become which HTTP status.

### [docs/api.md](docs/api.md)

The full REST surface as one table: sign-in, tokens, workout CRUD, completion, platforms,
FIT export and the MCP tools over plain HTTP. Explains the `.json` suffix, 401 before 404,
and posting a recording as raw bytes.

### [docs/prompts.md](docs/prompts.md)

The MCP prompt surface, which is one template: the getting-started interview that fills an
athlete's context. What it asks, why the same body is reached four ways, and the band-width
rules it writes that no schema can express.

### [docs/context.md](docs/context.md)

The four markdown documents an assistant reads before it plans. Why they are context rather
than configuration, why only the library has a built-in document, why reading and writing
them are separate tools, and the backup archive.

### [docs/auth.md](docs/auth.md)

Sign-in end to end: setting up Google, Apple and intervals.icu, why accounts are never
linked across providers, why the in-flight sign-in is remembered in both D1 and a cookie,
and how sessions and `wk_` API tokens are stored.

### [docs/integrations.md](docs/integrations.md)

Training platforms, of which intervals.icu is the first. Connecting by OAuth, why the token
is encrypted rather than hashed, and the sync semantics both ways: upserts on a stable key,
a failure there never failing your write, completions by webhook, and reading their
calendar back.

### [docs/recordings.md](docs/recordings.md)

Asking for the sessions you actually recorded and getting a signed link that streams them
as a ZIP of FIT files. Why the link carries no credential, what it costs to be a four-hour
bearer token, and why forty sessions is the cap.

### [docs/stats.md](docs/stats.md)

What the athlete actually did, read off the recorded FIT file once and stored with the
workout. The payload — session totals, laps, quarters, target bands — and the rules that
keep it honest: withheld mappings, nulls that are never zero.

### [docs/database.md](docs/database.md)

D1 and the schema: how migrations are written and tested, why the steps are TEXT with a
`json_valid` check, the 7/14-day retention window and how it is enforced, and the
write-ordering rules a change here must keep.

### [docs/architecture.md](docs/architecture.md)

The module map and how a request moves through it: the OAuth provider wrapping everything,
the routing table, and `withUser`. Read this before adding a route, a module, or a second
training platform.

### [docs/fit.md](docs/fit.md)

What you need before touching `src/fit.ts`: the SDK writes parent fields only, nested
repeats are flattened with the repeat after its children, an open range end is filled
rather than omitted, and the encoder's buffer has to be clamped.

### [docs/ios.md](docs/ios.md)

The iPhone app in `ios/`, and why it has no watch app. How a resolved plan becomes a
`CustomWorkout`, which targets are dropped rather than guessed at, how HealthKit's series
become one recording, and what the background upload path needs to stay alive.

### [docs/testing.md](docs/testing.md)

How the suite is put together and why. Tests run inside `workerd`; FIT files are asserted
by decoding them again with Garmin's own decoder; the outside world is an auxiliary Worker
Miniflare routes outbound traffic to. Lists what each suite covers.

---

## Licence

MIT — see [LICENSE](LICENSE).

This project depends on [`@garmin/fitsdk`](https://github.com/garmin/fit-javascript-sdk),
which Garmin ships under the **Flexible and Interoperable Data Transfer (FIT) Protocol
License**, not an OSI licence. Nothing from the SDK is vendored here, but if you
redistribute a build, read Garmin's terms first.
