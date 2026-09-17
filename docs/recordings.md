# Recorded sessions, as one download

A workout goes *out* to a watch as a FIT file; the session the athlete actually recorded
comes *back* as one, and this is how they ask for a batch:

1. `list_recorded_workouts` over MCP — or `GET /api/recordings` — for a date range on a
   connected platform. It answers with what is there and a **signed link**, good for four
   hours.
2. Follow the link. It streams a **ZIP of FIT files** plus a `manifest.json`. No credential
   is needed.

This is the **drill-down**, not the routine path: a session matched to a planned workout
has already been reduced to numbers that `get_workout_stats` answers with
([stats.md](stats.md)). The archive is for a lap that looks wrong, a within-rep detail, or
a session that was never planned here.

## The listing

```
GET /api/recordings?platform=intervals&from=2026-09-05&to=2026-09-12&sport=running
```

| Parameter | |
| --- | --- |
| `platform` | **Required.** Which platform recorded them, e.g. `intervals` |
| `from`, `to` | **Required.** Inclusive `YYYY-MM-DD`, in the athlete's own local days |
| `sport` | Optional. Repeat it, or comma-join: `sport=running&sport=cycling` |

`platform` is required even though intervals.icu is the only one: a parameter that may be
left out is one whose meaning changes the day a second platform is connected, and every
link ever issued would quietly start covering more.

```json
{
  "platform": "intervals",
  "from": "2026-09-05", "to": "2026-09-12",
  "sport": ["running"],
  "count": 4, "omitted": 0,
  "sessions": [
    {
      "platform": "intervals", "id": "i44031892", "date": "2026-09-07",
      "name": "Long Run", "sport": "running", "activity_type": "TrailRun",
      "distance_m": 21097, "moving_time_s": 7200,
      "comment": "Hot. Walked the last climb.",
      "file": "2026-09-07-i44031892-Long-Run.fit"
    }
  ],
  "download_url": "https://<worker>/downloads/completed-workouts.zip?claims=…&signature=…",
  "expires_at": "2026-09-12T14:22:31.000Z",
  "note": "Follow download_url within 4 hours for a ZIP of 4 FIT file(s)…"
}
```

`comment` is the activity's description as it stands upstream — the platform's text, not
necessarily the athlete's, and never adopted out of it (see
[integrations.md](integrations.md#the-comment-goes-out-and-never-comes-back)). `file` is the
name that session has inside the archive, and the same name `src/drive/` gives it. Nothing
matched means no link.

The platform's own activity type is placed back on our scale by `sportOf` in
`src/platforms/intervals.ts`, derived from the maps that push a workout the other way. A
type we cannot place stays `sport: null` — it still lists, but a `sport` filter leaves it
out, because "we could not tell" and "a generic workout" are different answers.

## Two limits

**At most 40 sessions** in one archive, and **at most 14 days** in one range.

The first is the real constraint: every session is a download its own request has to make,
and a Worker gets fifty outbound subrequests on the free plan. The second follows — a
fortnight of training is rarely forty sessions, so an archive is almost always the whole
answer. Working around a range limit is cheap; noticing a truncated answer is not.

The range check actually allows fifteen days, for the same reason `READ_SLACK_DAYS` exists
in [database.md](database.md). A range holding more than forty sessions is not refused
either — it comes back with the oldest forty and `omitted`.

## The link

```
/downloads/completed-workouts.zip?claims=<base64url>&signature=<base64url>
```

The path is a fixed, plain `.zip` so anything naming a download after its URL gets
`completed-workouts.zip`; the credential rides in the query, in base64url, whose alphabet
needs no escaping there.

The claims are a small JSON object — version, athlete, platform, range, sports, expiry —
and the signature is HMAC-SHA-256 over exactly that base64url text. The key is derived from
`CREDENTIALS_SECRET` under its own label, so it is not usable in place of the key
`src/platforms/store.ts` encrypts tokens with.

**The claims are signed, not encrypted.** Anyone holding the link can decode the athlete
id, the range and the sports — they can also just follow it and read the files, which says
more. What the signature buys is that they cannot *change* any of it. The signature is
checked before a single field inside is read.

It sits outside `/api/` deliberately, because `withUser` guards that prefix and the whole
purpose of this link is that it can be handed to something holding no account.

**A link is a bearer credential for its four hours.** It cannot be called back, only
outlived — the same property that makes it storage-free — though disconnecting the platform
does break it. Four hours is long enough to hand a link to an assistant and short enough
that one left in a chat transcript is worthless by the time anyone finds it. Responses carry
`Cache-Control: no-store` and `X-Robots-Tag: noindex`.

## The archive

Built in `src/recordings/zip.ts` and written as it goes out: an entry's local header, its
bytes relayed straight from the platform, then a data descriptor carrying the CRC and the
size — which is the whole trick, because none of those is known until the file has been read
and by then its header is long gone down the wire. Nothing is held but the chunk in hand.

**Stored, not deflated.** CPU is the scarce thing, not bandwidth, and a FIT file is already
packed binary. The CRC is the one per-byte pass that cannot be skipped.

Plain ZIP, not ZIP64, so 4 GiB and 65,535 entries are the ceilings — both thrown on rather
than written wrong, since a reader meeting a truncated 32-bit size reports a corrupt archive
and not the reason for it.

Every archive carries a `manifest.json`, written **last** so it can report what happened:
the range, the files, `omitted`, and `failed`. A session whose file cannot be fetched is
stepped over rather than failing the archive — some have no file at all (a manual entry, or
one from Strava with no streams) and one of those must not cost the athlete the other
thirty.

## Nothing is kept

No table, no row, no ledger: the listing is asked of the platform when it is asked for, and
the archive re-resolves the link's own query and fetches the files again when it is
followed. So a link resolves against the platform's *current* state, not the state it was
signed over — a session deleted upstream turns up in `failed`, one uploaded since turns up
in the archive without having been in the listing.

`src/recordings/index.ts` holds the query, the signed link and the manifest;
`src/recordings/zip.ts` is the streaming ZIP writer and nothing else;
`src/routes/recordings.ts` has both routes. The file naming lives in `index.ts` and
`src/drive/` imports it rather than the other way round: a file the copier writes and a file
leaving in an archive are the same session by different routes.
