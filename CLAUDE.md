# Notes for an assistant working in this repo

Short, and only the things that are not obvious from the code.

## Migrations run themselves on deploy

The Cloudflare Workers Build applies `migrations/` on a push, so a migration
merged alongside the code that reads its column lands before that code serves
a request. Do not warn about an unapplied migration, and do not treat an
additive column as something to sequence across two deploys. `npm run db:remote`
is for a first-time setup or a local database, not for shipping a change.

## Checks to run before pushing

```bash
npm run typecheck          # both tsconfigs; the client has its own
npm test                   # builds, then runs vitest against workerd
node scripts/check-readme.mjs
```

`npm test` builds first on purpose: the tests run the real Worker, with
`test/upstream-provider.js` standing in for every outbound host.

## Tool descriptions are charged for every session

`TOOLS` in `src/tools.ts` is serialised in full on every `tools/list`, before an
assistant has decided to call anything. Keep each `description` to about 50
words, and say only what a caller cannot get from the name and the schema — a
non-obvious order of calls, a unit or sentinel that would be misread, a limit
that will be hit, a constraint that protects the athlete. The comment above
`TOOLS` has the rule and the reasoning.

## Where the prose lives

`docs/` is the reference and is kept current with the code — a change to
behaviour that is described there is not finished until the description is too.
`README.md` indexes those docs, and `scripts/check-readme.mjs` enforces that
every one of them has an entry of 50-100 words.
