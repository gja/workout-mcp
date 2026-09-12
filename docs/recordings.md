# Recorded sessions, as one download

The counterpart to planning. A workout goes *out* to a watch as a FIT file; the
session the athlete actually recorded comes *back* as one, and this is how they
ask for a batch of them:

1. `list_recorded_workouts` over MCP — or `GET /api/recordings` — for a date
   range on a connected platform. It answers with what is there and a **signed
   link**, good for four hours.
2. Follow the link. It streams a **ZIP of FIT files**, plus a `manifest.json`
   naming everything in it. No credential is needed to follow it.

The point is an assistant that can look at real training: ask what was recorded
last week, fetch the archive, read the files. Nothing about any of it is stored
here — see [Nothing is kept](#nothing-is-kept).

## The listing

```
GET /api/recordings?platform=intervals&from=2026-09-05&to=2026-09-12&sport=running
```

| Parameter | |
| --- | --- |
| `platform` | **Required.** Which platform recorded them, e.g. `intervals` |
| `from`, `to` | **Required.** Inclusive `YYYY-MM-DD`, in the athlete's own local days |
| `sport` | Optional. Repeat it, or comma-join: `sport=running&sport=cycling` |

`platform` is required even though intervals.icu is the only one there is. A
parameter that may be left out is one whose meaning changes the day a second
platform is connected — every link ever issued would quietly start covering
more — and a caller that never had to say what it meant has no way to notice.

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
      "file": "2026-09-07-i44031892-Long-Run.fit"
    }
  ],
  "download_url": "https://<worker>/downloads/completed-workouts.zip?claims=…&signature=…",
  "expires_at": "2026-09-12T14:22:31.000Z",
  "note": "Follow download_url within 4 hours for a ZIP of 4 FIT file(s)…"
}
```

`file` is the name that session has inside the archive, and the same name
`src/drive/` gives it: one file, two routes out, named once.
Nothing matched means no link — there is no point signing an empty archive.

### Sport

The platform's own activity type (`Run`, `TrailRun`, `VirtualRide`) is placed
back on our own scale by `sportOf` in `src/platforms/intervals.ts`, derived from
the maps that push a workout the other way so the two stay in step. A type we
cannot place stays `sport: null`: it still lists, but a `sport` filter leaves it
out, because "we could not tell" and "a generic workout" are different answers
and only the second should match.

### Two limits

**At most 40 sessions** in one archive, and **at most 14 days** in one range.

The first is the real constraint, and it is not about storage: every session in
the archive is a download its own request has to make, and a Worker gets fifty
outbound subrequests on the free plan. Forty leaves headroom for the listing
call and whatever else the request does.

The second follows from the first. A fortnight of training is rarely forty
sessions, so the cap almost never bites and an archive is almost always the
whole answer — which is the property worth having. A caller wanting a month asks
twice and gets two complete archives; a caller silently handed two thirds of a
month has a gap it has to notice. Working around a range limit is cheap.
Noticing a truncated answer is not.

The range check actually allows **fifteen** days, for the same reason
`READ_SLACK_DAYS` exists in [database.md](database.md): a fortnight named by its
own edges — `from` a fortnight ago, `to` today — is fifteen days once both ends
are counted, and refusing that would make every caller meet an off-by-one before
their first successful call. Everything we *say* still says fourteen.

A range holding more than forty sessions is not refused either. It comes back
with the oldest forty and `omitted`, counting what was left, so a caller narrows
the range rather than starting again wondering what it missed.

## The link

```
/downloads/completed-workouts.zip?claims=<base64url>&signature=<base64url>
```

The path is a fixed, plain `.zip`: anything that names a download after its URL
gets `completed-workouts.zip` rather than a hundred characters of base64, so the
credential rides in the query instead. Both values are base64url, whose alphabet
needs no escaping there.

The claims are a small JSON object — version, athlete, platform, range, sports,
expiry — and the signature is HMAC-SHA-256 over exactly that base64url text, 32
bytes, 43 characters:

```
{"v":1,"u":"a1b2c3d4e5f6","p":"intervals","f":"2026-08-30","t":"2026-09-12","s":"running","x":1789222951}
  → claims=eyJ2IjoxLCJ1IjoiYTFiMmMzZDRlNWY2Ii…  (140 chars)
  → signature=-ZM13nUOKUnDILB2BWGbrsK_RfrDGxZ_B0pmuvSpTow
```

The key is derived from `CREDENTIALS_SECRET` under its own label — the same
passphrase `src/platforms/store.ts` encrypts tokens with, and a different key,
so neither is usable in the other's place.

**The claims are signed, not encrypted.** Anyone holding the link can base64-decode
them and read the athlete id, the range and the sports. That is not a leak worth
closing: they can also just follow the link and read the files themselves, which
says all of that and more. What the signature buys is that they cannot *change*
any of it — widen the range, swap the athlete, extend the expiry — because the
HMAC is over the whole of it.

It is outside `/api/`, and deliberately: `withUser` guards everything under that
prefix, and the whole purpose of this link is that it can be handed to something
holding no account. `/webhooks/intervals` sits outside for the same kind of
reason — it authenticates itself rather than being authenticated — and
[api.md](api.md) lists both.

### What that costs

**A link is a bearer credential for its four hours.** Anyone holding it can
fetch that athlete's files for that range. It cannot be called back, only
outlived — there is no record of it to revoke, which is the same property that
makes it storage-free. Disconnecting the platform does break it, because the
files are fetched with the athlete's platform token and there is then no token
to fetch them with.

Four hours is the trade: long enough to hand a link to an assistant, another
machine, or a person, and short enough that a link left in a log or a chat
transcript is worthless by the time anyone finds it. Responses carry
`Cache-Control: no-store` and `X-Robots-Tag: noindex`.

The signature is checked before a single field inside is *read*, let alone
believed. Until it holds, the athlete named in the claims is just something the
caller typed.

## The archive

Built in `src/recordings/zip.ts`, and written as it goes out: an entry's local
header, then its bytes relayed straight from the platform, then a data
descriptor carrying the CRC and the size — which is the whole trick, because
none of those three is known until the file has been read and by then its header
is long gone down the wire. Nothing is held but the chunk in hand, so an archive
far larger than the Worker's memory still leaves it.

**Stored, not deflated.** CPU is the scarce thing here, not bandwidth: the
archive is built inside one request's budget, and deflating every byte would
spend that budget to save a few per cent on a file format that is already packed
binary. The CRC is the one per-byte pass that cannot be skipped — a ZIP without
it is one a reader calls corrupt — and otherwise the copy is a straight relay.

Plain ZIP, not ZIP64, so 4 GiB and 65,535 entries are the ceilings. Both are
thrown on rather than written wrong, because a reader meeting a truncated 32-bit
size reports a corrupt archive and not the reason for it. The forty-session cap
means neither is ever approached.

### manifest.json

Every archive carries one, written **last** so it can report what happened:

```json
{
  "generated_at": "2026-09-12T10:22:31.000Z",
  "platform": "intervals", "from": "2026-09-05", "to": "2026-09-12",
  "sport": null,
  "files": [ { "id": "i44031892", "date": "2026-09-07", "sport": "running", "…": "…" } ],
  "failed": [ { "id": "i44031999", "date": "2026-09-08", "name": "Walk", "error": "intervals.icu answered 404" } ],
  "omitted": 0
}
```

A session whose file cannot be fetched lands in `failed` and is stepped over
rather than failing the archive. Some sessions have no file to fetch at all — a
manual entry, or one that arrived from Strava with no streams to build a FIT
from — and one of those must not cost the athlete the other thirty. The
scheduled copier in `src/drive/` tolerates the same thing for the same reason.

## Nothing is kept

No table, no row, no ledger. The listing is asked of the platform when it is
asked for; the link carries its own query; the archive re-resolves that query
and fetches the files again when it is followed. The only durable thing involved
is the athlete's platform token, which was already there.

Which means a link resolves against the platform's *current* state, not the
state it was signed over. A session deleted upstream in the meantime turns up in
`failed`; one uploaded in the meantime turns up in the archive without having
been in the listing. Both are the right answer — the archive is what is there
now — but a caller comparing the two should not expect them to be identical.

## Where it sits

```
src/recordings/index.ts   the query, the search, the signed link, the manifest
src/recordings/zip.ts     the streaming ZIP writer, and nothing else
src/routes/recordings.ts  GET /api/recordings, and the download outside the door
```

The file naming lives in `src/recordings/index.ts` and `src/drive/` imports it,
rather than the other way round: a file the copier writes and a file leaving in
an archive are the same session by different routes.
