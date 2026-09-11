# Testing

```bash
npm test        # vite build, then vitest run
npm run typecheck
```

Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`, so the FIT
encoder and the D1 queries are exercised on the same runtime that serves
production traffic. That is not incidental: the encoder's buffer problem (see
[fit.md](fit.md)) only reproduces on production workerd, and a test suite on
plain Node would have missed it.

FIT files are asserted by decoding them again with the SDK's own decoder, so
the test says what a watch would read rather than what we meant to write.

## Standing in for the outside world

Google, Apple, intervals.icu and Google Drive are stood in for by an auxiliary
Worker (`test/upstream-provider.js`) that Miniflare routes all outbound traffic
to, so the real `arctic` path runs — Apple's signed client secret included —
without touching the network.

The intervals.icu stand-in keeps a calendar, and a test reaches into it through
a service binding to see what actually landed, so a push is asserted against
the event that arrived rather than against the request we sent.

The Drive stand-in keeps folders and files, and answers the service account's
own token exchange — a throwaway RSA key is generated per run, so the JWT the
Worker signs is a real one. A test asserts the path a race landed at by walking
the parents Drive recorded, not by trusting the URL we asked for.

## Migrations

The suite replays every migration before each file, so a migration that does
not parse fails the build rather than the next deploy. `0002`, the one that
carries data, is tested against a row written in the old shape.

## The suites

| Suite | Covers |
| --- | --- |
| `migrations.test.ts` | The data-carrying migrations, the `json_valid` check, the external-id index, and querying steps from SQL |
| `workout.test.ts` | Parsing loose JSON: every duration and target, range semantics, repeats, intensity inference, and the error messages |
| `fit.test.ts` | FIT encoding, decoded back with the SDK: scaling, offsets, zones, names, intensities, repeat flattening, a full session |
| `api.test.ts` | The REST API and `/api/tools`, FIT downloads, cross-athlete isolation, bad requests, the readable window and the cap |
| `auth.test.ts` | Google and Apple sign-in, state handling, ID-token checks, sessions, API tokens |
| `oauth.test.ts` | Discovery, registration, consent, the PKCE code exchange, refresh, connected apps |
| `mcp.test.ts` | The JSON-RPC protocol and every tool |
| `platforms.test.ts` | Connecting intervals.icu, pushing creates, edits, moves and deletes, surviving an outage, and completions coming back |
| `drive.test.ts` | Configuring a shared drive and the write check, which sessions count as races, the path a copy lands at, the ledger claim, copying each once, and the per-run cap |
| `router.test.ts` | Pattern matching, parameter constraints, 405 apart from 404, HEAD on a GET route |

CI runs `npm run typecheck` and `npm test` on every push to `main` and every
pull request.
