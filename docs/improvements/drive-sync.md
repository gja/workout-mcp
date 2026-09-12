# Copying recorded sessions to a Google shared drive

**Status: still running, no longer offered.** The copier works and has not been
touched. What went is every way of reaching it — the Setup panel, the three
routes, and all the copy that told anyone it existed. A `drive_connections` row
that predates that still gets its sessions, on the hour, exactly as before. No
new one can be made without putting an interface back.

Removed from the interface in **PR #27**, over two commits: `765f738` took the
panel and the routes, `d9d571b` took the remaining copy and `docs/drive.md`.
The full doc is at `git show 765f738:docs/drive.md` — 318 lines, and the place
to start if this is ever revived.

## What it did

Connect a Google **shared drive**, and every session recorded on a connected
training platform was copied into it as a FIT file, hourly:

```
workouts-mcp/intervals.icu/2026-04/2026-04-19-i44031892-City-Marathon.fit
```

The point was that this server keeps no training data and has no charts, so
rather than start collecting any, it handed the files to somewhere the athlete
controlled. Every session, not only the races — the race flag turned out to be
the wrong filter, because it is usually ticked well after the upload.

## How it worked

The deployment held one **service account** (`GOOGLE_DRIVE_CLIENT_EMAIL` and
`GOOGLE_DRIVE_PRIVATE_KEY`); the athlete added it to their drive as a
Contributor and pasted the drive's link. `configure` proved it could *write* by
making the root folder — a Viewer, or a My Drive folder, reads fine and then
fails every copy — before storing anything.

Each hourly run listed recorded sessions for the last `LOOKBACK_DAYS`, skipped
those already in the `drive_copies` ledger, and relayed up to `COPY_LIMIT` of
them straight from the platform into Drive. The ledger row was claimed *before*
the bytes moved, so two overlapping runs could not both upload — Drive allows
duplicate names, so that would have been two files with one orphaned.

Three constraints shaped it, and all three still hold:

- **Only a shared drive.** A service account owns whatever it uploads and has
  no storage quota of its own, so a folder in someone's own Drive has nothing to
  charge the bytes to. Shared drives are a Workspace feature, which made the
  whole integration Workspace-only — the reason it never suited a free Gmail
  account, and a large part of why it was worth replacing.
- **Its own cron.** `40 * * * *`, separate from the completion sweep, so it got
  its own subrequest allowance rather than that sweep's leftovers.
- **Nothing about a session stored.** The recording was relayed inside one
  request; the ledger holds only which session went and where.

## Why it was replaced

[recordings.md](../recordings.md) answers "let me look at what I did" with a
signed ZIP download: no Workspace account, no service account, no drive to
share, nothing to set up. That is most of what this was for, at none of the
cost.

What a drive does that the download does not is **keep** the files. The
download is a relay — follow the link and the files come from the platform;
delete the session upstream and it is gone. A drive is durable, and that is a
real difference. It was not enough to justify the setup burden on the one
account type that could use it, but it is the thing to weigh if this comes back.

## What is still here

| | |
| --- | --- |
| `src/drive/index.ts` | The pass, the ledger claim, the naming, `configure`/`forget`/`status` |
| `src/drive/google.ts` | Service-account JWT, folder lookup, the multipart upload |
| `src/drive/store.ts` | `drive_connections` and `drive_copies` |
| `migrations/0006_drive.sql` | Both tables |
| `src/index.ts` | The `40 * * * *` branch that calls `copyForEveryone` |
| `test/drive.test.ts` | Full coverage, driving the module directly rather than HTTP |

`fileName` no longer lives here — it moved to `src/recordings/` and this imports
it, so a file the copier writes and a file leaving in an archive are named
identically on purpose.

## To bring it back

1. Restore the handlers and the three routes in `src/routes/integrations.ts`,
   and put `drive: await drive.status(env, user)` back on `readConfig`
   (`git show b29c23a:src/routes/integrations.ts`).
2. Restore `src/client/components/Drive.tsx`, its section in `main.tsx`, and the
   `DriveStatus`/`DriveReport` types and three calls in `src/client/api.ts`
   (`git show b29c23a:src/client/components/Drive.tsx`).
3. Put the Google Drive clauses back in `public/privacy-policy.html` — both of
   them, the stored-data one and the who-else-sees-it one
   (`git show 765f738:public/privacy-policy.html`).
4. Restore `docs/drive.md` and its README index entry; `npm run check:readme`
   enforces the entry.

Nothing underneath changed, so none of this needs rewriting — only lifting.

## Before touching the production cron

The privacy policy no longer names Google as a recipient. If
`drive_connections` is not empty, a live flow is going undisclosed: either stop
the cron, clear the table, or put the clause back. Check it before assuming the
question is academic.
