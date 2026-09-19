# Testing

```bash
npm test        # vite build, then vitest run
npm run typecheck
```

Tests run inside `workerd` via `@cloudflare/vitest-pool-workers`, on the same runtime
that serves production. Not incidental: the encoder's buffer problem (see
[fit.md](fit.md)) only reproduces there.

FIT files are asserted by decoding them again with the SDK's own decoder, so a test says
what a watch would read. The other direction goes through the SDK's encoder —
`test/activity-fit.ts` writes an activity file from a list of laps, one record a second,
so stats read off it can be asserted against numbers the test chose.

Google, Apple, intervals.icu and the Google APIs are stood in for by an auxiliary Worker
(`test/upstream-provider.js`) that Miniflare routes outbound traffic to, so the real
`arctic` path runs — Apple's signed client secret included — offline. The intervals.icu
and Drive stand-ins keep state a test reaches through a service binding, so a push is
asserted against what landed rather than against the request we sent. The Drive stand-in
generates a throwaway RSA key per run, so the service account's JWT is a real one.

Every migration is replayed before each file, so one that does not parse fails the build
rather than the next deploy. `0002`, which carries data, is tested against a row in the
old shape.

## The suites

| Suite | Covers |
| --- | --- |
| `migrations.test.ts` | The data-carrying migrations, the `json_valid` check, the external-id index |
| `workout.test.ts` | Parsing loose JSON: durations, targets, ranges, repeats, intensity, errors |
| `fit.test.ts` | FIT encoding, decoded back: scaling, offsets, zones, repeat flattening |
| `api.test.ts` | REST and `/api/tools`, downloads, cross-athlete isolation, the window and cap |
| `auth.test.ts` | Google and Apple sign-in, state, ID-token checks, sessions, API tokens |
| `oauth.test.ts` | Discovery, registration, consent, the PKCE exchange, refresh, connected apps |
| `mcp.test.ts` | The JSON-RPC protocol and every tool |
| `platforms.test.ts` | Connecting, pushing edits and deletes, surviving an outage, completions, importing what is planned there |
| `stats.test.ts` | Reading a recorded FIT file: totals, step mapping, quarters, band, flags |
| `format.test.ts` | The dashboard's formatting, under the client's tsconfig |
| `drive.test.ts` | The copier: the write check, the path, the ledger claim, the per-run cap |
| `router.test.ts` | Pattern matching, constraints, 405 apart from 404, HEAD on a GET route |

CI runs `npm run typecheck` and `npm test` on every push to `main` and every pull request.
