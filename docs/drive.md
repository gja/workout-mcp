# Google Drive

Nothing here keeps your training data. That is the point of the project, and it
is also the limit of it: there is no heart-rate stream to look at, no GPS track,
no history to plot. So instead of collecting any of that, this integration
hands it to you.

Connect a Google shared drive and **every race you record on a connected
training platform is copied into it as a FIT file**, on the hour, as:

```
workouts-mcp/2026-04/intervals.icu/2026-04-19-i44031892-City-Marathon.fit
```

From there it is yours. Point an assistant at the folder, open it in whatever
analysis tool you like, keep it for the decade — none of that involves this
server, which is exactly the arrangement we want.

Only races are copied. An ordinary Tuesday evening session stays where it is; a
race is a session you marked as one on the platform, which is a decision you
already made for your own reasons.

## Setting up the service account

This is the deployment's side of it, done once. Skip to [Connecting a
drive](#connecting-a-drive) if someone else has already run these.

1. **Make a Google Cloud project**, or pick an existing one, at
   [console.cloud.google.com](https://console.cloud.google.com/projectcreate).
   Note its id.

2. **Enable the Drive API** for that project:
   [console.cloud.google.com/apis/library/drive.googleapis.com](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   → **Enable**. Without this every call comes back 403 with a message naming
   the project, which is the usual first failure.

3. **Create a service account**:
   [console.cloud.google.com/iam-admin/serviceaccounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
   → **Create service account**. A name like `workouts-mcp` is fine. It needs
   **no** project roles — grant nothing on the *Grant access* step. All of its
   access comes from being a member of an athlete's drive.

4. **Give it a key**: open the service account → **Keys** → **Add key** →
   **Create new key** → **JSON**. A file downloads. It is a credential; treat
   it like one, and note that Google will not show it to you again.

5. **Put the two halves on the Worker.** The JSON has a `client_email` and a
   `private_key`:

   ```bash
   npx wrangler secret put GOOGLE_DRIVE_CLIENT_EMAIL   # workouts-mcp@<project>.iam.gserviceaccount.com
   npx wrangler secret put GOOGLE_DRIVE_PRIVATE_KEY    # the whole -----BEGIN PRIVATE KEY----- block
   ```

   The private key is PEM PKCS#8. Paste it exactly as the JSON has it — the
   literal `\n` escapes the JSON uses are understood, and so are real newlines,
   so however your shell mangles it on the way in it should still parse.

6. **Redeploy**, and the Google Drive panel on the dashboard turns from a
   warning into a form showing the service account's address.

Nothing else is needed: no OAuth consent screen, no verification, no scopes to
justify to Google. A service account authenticates as itself.

## Connecting a drive

What an athlete does, once:

1. In Google Drive, make a **shared drive** — *New* → *Shared drive* in the
   left-hand column. An ordinary My Drive folder will also work, but see
   [Why a shared drive](#why-a-shared-drive) first.
2. Open it, **Manage members**, and add the service account's address (the
   dashboard shows it) as a **Content manager**.
3. Copy the drive's link from the address bar and paste it into the **Google
   Drive** panel on the dashboard.

The address is checked against Google there and then, so a drive that was never
actually shared fails at the form rather than silently never syncing, and the
first copy runs immediately instead of waiting for the hour.

### Why a shared drive

A service account has no Drive storage of its own — no Google Workspace
licence, so no quota. A file it creates in *your* My Drive folder is owned by
the service account and counts against a quota that does not exist, which
Google refuses with a storage error. In a shared drive the *drive* owns the
file, so there is no quota to charge it to, and the file is unambiguously
yours: revoking the service account's membership leaves every file already
there untouched and no longer reachable by us.

A personal folder shared with the service account does work on consumer
accounts, where Google is more forgiving about ownership. It is not the
supported path, and the failure if it stops working is a storage quota error
that reads as though it is about your own Drive being full.

### Why a service account, not your Google sign-in

Signing in with Google here asks for your identity and nothing else. Asking
instead for permission to write to your Drive would mean holding a refresh
token that can reach your Drive for as long as you leave it granted — a much
larger thing to store, and on a server whose whole claim is that it stores very
little.

A service account inverts that. The credential is the deployment's, not yours;
it can reach nothing until you add it to a drive, and it reaches nothing else
ever. Revoking it is a membership change you make in Google Drive, without
asking us, and it takes effect for every future copy at once.

The token is requested with the broad `drive` scope, because `drive.file` — per
file the app itself created — cannot look a drive up or place a folder inside
one. What actually bounds the credential is membership: the scope describes
what the service account may do to drives it is a member of, and it is a member
of exactly the drives athletes have added it to.

## The path, and why each part of it is there

```
workouts-mcp/            everything this writes, under one folder, so nothing else is touched
  2026-04/               the race's month, so a drive with years in it stays navigable
    intervals.icu/       which platform it came from, by the name a person knows it by
      2026-04-19-i44031892-City-Marathon.fit
```

The file name is the race's local date, the platform's own id for it, and the
name you gave it. The date sorts; the id is what makes the name unique and what
you would quote in a support thread; the name is for recognising it in a
folder. The extension is always `.fit`, which is what the contents always are.

The name is sanitised down to letters, numbers, dots, dashes and underscores —
a race called `10k / "PB" attempt` becomes `10k-PB-attempt`. Drive would accept
a slash, and then you would have a file that no path can name.

The platform folder is the adapter's display label rather than its internal id,
which is what keeps `src/drive/` from knowing that intervals.icu exists.

## Nothing is kept here

The recording never reaches this database. A copy is one pass: the bytes are
requested from the training platform and handed to Google inside the same
request, held only in memory while it happens and then gone. The only thing
written down is a row saying *this race, on this platform, went to this path* —
which exists so the next hourly pass does not copy it a second time.

The bytes pass through an `ArrayBuffer` rather than a stream, because Google's
multipart upload wants a `Content-Length` and a Worker cannot put one on a
streamed request body. A recording above `MAX_UPLOAD_BYTES` (64 MB) is refused
rather than relayed — far above any real FIT file, and far below what an isolate
may hold.

## One copy, and only one

A race is copied when it is first seen and never again. Re-analysing it
upstream, renaming it, or fixing its GPS does not produce a second file, and
does not overwrite the one in your drive — which may by then be a file you have
annotated, moved, or built a spreadsheet next to. If you do want the newer
version, delete the ledger row by disconnecting and reconnecting the drive; the
files already copied stay where they are, and everything inside the lookback is
copied again.

Deleting the copy in Drive does not bring it back either, for the same reason.

## What a run does

`copyNow` brings one athlete's drive up to date:

- Ask every connected platform that offers races for the ones it has, from
  `LOOKBACK_DAYS` (30) ago to today.
- Drop the ones already in the ledger, and take the oldest `COPY_LIMIT` (3) of
  what is left.
- For each: make the folders if they are not there, ask the platform for the
  file, hand it to Google, write the ledger row.

The lookback is deliberately **not** the retention window. That window exists to
bound what the database holds, and the database holds nothing about a race, so
it has no bearing here. Thirty days means connecting a drive the week after a
race still catches the race.

The per-run cap is the Worker's outbound subrequest budget: each copy is a
download and an upload, on top of the folder lookups, and on the hourly cron all
of that shares one invocation's budget with the completion pass that runs first.
That budget is 50 subrequests on Cloudflare's free plan, which is why both caps
here are small. A drive with a backlog fills in over consecutive hourly passes
rather than failing the first one, and the standing error says how many are
left. As with a training platform, a run is the only thing that clears that
error, and only when it finds nothing left to do.

The hourly cron does this for a batch of `COPY_BATCH` (5) athletes, least
recently visited first, so consecutive passes work round everybody. An error is
per-athlete: one drive whose membership was revoked must not stop the sweep for
anyone else.

The folder ids are cached for the run, keyed by month and platform, because a
run is usually several races in the same month and each miss is three more
lookups out of the same budget.

## Where a race comes from

A platform adapter may offer two more functions than the four in
[integrations.md](integrations.md):

```ts
competitions(key, from, to): Promise<Competition[]>   // which recorded sessions were races
recording(key, competition): Promise<RecordedFile>    // the FIT behind one
```

Both are optional, and `src/drive/` asks only the platforms that have them. A
platform with no notion of a race simply never appears in a drive.

For intervals.icu, a race is an activity with `race: true` or `sub_type:
"RACE"` — both are how an athlete marks one there, and either one counts. The
file is `GET /activity/{id}/file`, the athlete's own upload, when the platform
says that upload was a FIT. When it was a GPX, or the activity came in from
Strava and there is no original, it falls back to `GET
/activity/{id}/fit-file`, which intervals.icu builds from the stored streams.
So the `.fit` in the name is always true, even when what the watch produced is
not what arrives.
