# Google Drive

Nothing here keeps your training data. That is the point of the project, and it
is also the limit of it: there is no heart-rate stream to look at, no GPS track,
no history to plot. So instead of collecting any of that, this integration
hands it to you.

Connect a Google shared drive and **every race you record on a connected
training platform is copied into it as a FIT file**, on the hour, as:

```
workouts-mcp/intervals.icu/2026-04/2026-04-19-i44031892-City-Marathon.fit
```

From there it is yours. Point an assistant at the folder, open it in whatever
analysis tool you like, keep it for the decade — none of that involves this
server, which is exactly the arrangement we want.

Only races are copied. An ordinary Tuesday evening session stays where it is; a
race is a session you marked as one on the platform, which is a decision you
already made for your own reasons.

> **This needs a Google Workspace account.** It writes into a *shared drive*,
> and shared drives are a Workspace feature — a free Gmail account cannot
> create one, so it cannot use this integration. The reason is not a policy
> choice; it is [what a service account can own](#only-a-shared-drive).

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
   left-hand column. This is the Workspace-only part; a folder will not do, and
   is refused. See [Only a shared drive](#only-a-shared-drive).
2. Open it, **Manage members**, and add the service account's address (the
   dashboard shows it) as a **Contributor** — see [What it is allowed to
   do](#what-it-is-allowed-to-do).
3. Copy the drive's link from the address bar and paste it into the **Google
   Drive** panel on the dashboard.

The drive is checked against Google there and then — and checked by *writing*
to it, not merely reading: the `workouts-mcp` folder is created as part of
connecting. A Viewer, or a folder the service account cannot own files in, fails
at the form rather than connecting cleanly and then failing every copy for
reasons nobody sees. The first copy runs immediately instead of waiting for the
hour.

### What it is allowed to do

**Contributor** is the minimum, and it is the right one: the integration adds
folders and uploads files, and never moves, renames or deletes anything.

| Where | What is needed |
| --- | --- |
| Google Cloud IAM | **nothing** — no project roles at all |
| Google Cloud APIs | the **Drive API** enabled on the project |
| OAuth scope (ours, not yours to set) | `https://www.googleapis.com/auth/drive` |
| Shared drive membership | **Contributor** |

Content manager also works and is what you want if you would rather *we* could
tidy up, but nothing here ever will. Commenter and Viewer cannot create the
folder, so connecting fails.

### Only a shared drive

A folder is refused, and the refusal says why. It is the one restriction here
worth understanding, because the link looks the same either way:
`drive.google.com/drive/folders/<id>` is what you copy for a shared drive's root
*and* for a folder in your own Drive.

Google charges storage against whoever **owns** a file. A service account owns
everything it uploads and has no storage of its own — no Workspace licence, no
quota — so a file in your My Drive folder is charged to an account with nowhere
to put it, and Google refuses it with `storageQuotaExceeded`. That reads as
though *your* Drive is full and has nothing to do with your Drive. In a shared
drive the **drive** owns the file, so there is no quota to charge, and the file
is unambiguously yours: revoking the service account's membership leaves
everything already there untouched and no longer reachable by us.

So the check at connect time asks `drives.get` and accepts nothing else. A
folder answers 404 there, and rather than guess, the code asks what the id
actually is and names it in the refusal. A folder that would have connected
cleanly and then failed every upload is worse than one that fails at the form.

A *subfolder of a shared drive* would in fact work — the drive still owns the
file — and is refused all the same. "Paste the shared drive" is a rule an
athlete can follow; "paste the drive, or a folder inside a shared drive, but not
a folder in your own Drive" is not.

There is a third arrangement that works on a personal folder: **domain-wide
delegation**, where the service account impersonates a real user and that user
owns the files. It needs a Workspace admin to grant it — so it does not help a
free account either — and this integration does not implement it.

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
  intervals.icu/         which platform it came from, by the name a person knows it by
    2026-04/             the race's month, so a drive with years in it stays navigable
      2026-04-19-i44031892-City-Marathon.fit
```

Platform above month, rather than the other way round: a month folder per
platform means one folder per month you actually raced in, where month-first
would make a new set of platform folders inside every month. Fewer folders, and
a single place to look for everything one platform has ever sent.

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

The bytes are assembled in memory rather than streamed, because Google's
multipart upload wants a `Content-Length` and a Worker cannot put one on a
streamed request body. A recording above `MAX_UPLOAD_BYTES` (16 MB) is refused
rather than relayed — far above any real FIT file, and far below what an isolate
may hold. The cap is applied to the bytes *as they arrive*, not to the
platform's `Content-Length`: the `/fit-file` fallback often sends no length at
all, and a cap that only checks a header it may never be given is no cap. An
out-of-memory kill cannot be caught, so this guard has to come first.

## One copy, and only one

A race is claimed in the ledger *before* its bytes move, not after. **Copy now**
can overlap the hourly pass, and two runs that had each read an empty ledger
would both upload — Drive allows duplicate names, so that is two files, one of
them orphaned. The ledger's primary key settles it instead: the run that loses
the insert skips the race. `file_id` stays null until the upload lands, so a
claim whose download failed is released and tried again rather than lost, and a
claim still in flight is not counted as a copy on the dashboard.

Beyond that race, a race is copied when it is first seen and never again. Re-analysing it
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
- For each: claim it in the ledger, make the folders if they are not there, ask
  the platform for the file, hand it to Google, then name the file on the claim.

The lookback is deliberately **not** the retention window. That window exists to
bound what the database holds, and the database holds nothing about a race, so
it has no bearing here. Thirty days means connecting a drive the week after a
race still catches the race.

The per-run cap is the Worker's outbound subrequest budget, which is 50 on
Cloudflare's free plan: each copy is a download and an upload, on top of up to
six folder lookups on a cold run, so `COPY_BATCH` (3) athletes at `COPY_LIMIT`
(3) races each comes to about forty. That is also why the drive pass has its own
cron rather than riding along on the completion sweep — that one already spends
up to 40 subrequests of its own, and two jobs in one invocation would share a
budget neither fits in twice.

A drive with a backlog fills in over consecutive hourly passes rather than
failing the first one, and the report says how many are left. A backlog is
deliberately **not** written to the connection as a standing error, unlike a
training platform's: there is nothing an athlete can do about it and it clears
itself within the hour, so calling it a failed copy on the dashboard would be a
lie. Only a real failure is recorded, and the next clean run clears it.

The pass takes a batch of `COPY_BATCH` (3) athletes, least recently visited
first, so consecutive passes work round everybody. An error is per-athlete: one
drive whose membership was revoked must not stop the sweep for anyone else.

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
