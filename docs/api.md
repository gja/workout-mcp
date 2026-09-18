# HTTP API

Authenticate with `Authorization: Bearer <token>` or, from a browser, the session cookie
set at login.

| Route | Does |
| --- | --- |
| `GET /api/health` | Liveness, no auth |
| `GET /auth/providers` | Which sign-in providers are configured |
| `GET /auth/:provider/start` | Begin a Google, Apple or intervals.icu sign-in |
| `GET`/`POST /auth/:provider/callback` | Finish it, sets the session cookie |
| `GET /auth/intervals/connect` | Begin connecting intervals.icu to the account you are signed in as |
| `GET /auth/intervals/connect-callback` | Finish that, storing the token; no session is touched |
| `POST /api/auth/logout` | End the session |
| `GET /api/me` | Who you are, and the retention window |
| `GET /api/tokens` | List API tokens |
| `POST /api/tokens` | `{name}` — mint an API token, returned once |
| `POST /api/app-token` | `{name}` — the same, for a native app holding an OAuth grant rather than a cookie; needs the `app-token` scope |
| `DELETE /api/tokens/:prefix` | Revoke one |
| `GET /api/connections` | List OAuth grants (connected MCP clients) |
| `DELETE /api/connections/:id` | Disconnect one |
| `GET /api/workouts.json?from=&to=` | List within the retention window; a wider range is narrowed to it |
| `GET /api/workout-plans?plan-ids=` | Those plans resolved — one duration and its targets a step, repeats kept — for a client that schedules them |
| `POST /api/workouts` | Create; returns the id and URLs |
| `GET /api/workouts/:date/:id.json` | Read one |
| `GET /api/workouts/:date/:id/stats` | What was actually recorded against it, laps and all; 404 until a session comes back |
| `POST /api/workouts/:date/:id/recording` | The recorded FIT file itself as the body; read for its stats, marks the session done, keeps nothing |
| `PUT /api/workouts/:date/:id.json` | Replace one; change `date` to move it |
| `PUT /api/workouts/:date/:id/date` | Move it to another day; `{date}` in the body, keeping the id and the record of it being done |
| `DELETE /api/workouts/:date/:id.json` | Delete one |
| `POST /api/workouts/:date/:id/complete` | Mark it done; `{completed_at}` optional, defaults to now |
| `DELETE /api/workouts/:date/:id/complete` | Clear that, leaving the plan alone |
| `PUT /api/workouts/:date/:id/comment` | The athlete's note on how it went; `{comment}`, synced to the platform |
| `DELETE /api/workouts/:date/:id/comment` | Clear the note, there as well as here |
| `GET /api/context` | Every context document an assistant reads, where each stands, and the tool that reads it |
| `GET /api/context.zip` | All of them as `backup-context.zip`, plus a manifest |
| `GET /api/context/:kind` | One of them |
| `PUT /api/context/:kind` | `{markdown}` — replace it; empty clears it, over 100 KB is refused |
| `DELETE /api/context/:kind` | Forget what they wrote, going back to the built-in document or to nothing |
| `GET /api/config` | Every integration and where each one stands |
| `PUT /api/config/:integration` | Answers 400: a platform is connected by OAuth, not by a body |
| `DELETE /api/config/:integration` | Disconnect, forgetting what was stored for it |
| `POST /api/sync/:integration` | Run that integration's sync now |
| `GET /api/recordings?platform=&from=&to=&sport=` | Sessions you actually recorded, and a signed link to their files |
| `GET /export/:date-:id.fit` | The FIT file |
| `POST /api/tools/:name` | Any MCP tool, over REST |
| `POST /webhooks/intervals` | intervals.icu's own callback; theirs to call, not yours |
| `GET /downloads/completed-workouts.zip?claims=&signature=` | Those files as one ZIP. No auth: the signature is the credential |

`:integration` is a training platform's id (`intervals`). A platform has no `PUT` body
because it is connected by an OAuth round — the two `/auth/intervals/connect*` routes —
so that path answers 400 and says so. Syncing is under `/api/sync` rather than
`/api/config` because telling an integration to run now is not a setting; nothing has to
call it, it is the dashboard's "Sync now" button.

`:kind` is one of `workout-library`, `current-plan`, `scheduling-instructions` and
`workout-zones`. Three are writable over MCP; the library is not. See
[context.md](context.md).

`.json` is a second spelling of any `/api/` path, stripped before routing, so each route
is declared once.

A date may hold several workouts, each with its own short id.

## The `:date` in a path is ignored

A workout id is unique per athlete, so **the id is what every single-workout route
resolves by** and the date in the path is taken and ignored. A client holding the address
of a workout that has since moved still reaches it, and a 404 means the workout is gone
rather than that it was looked for on the wrong day — so the body says `no workout
a1b2c3d4`, with no date in it.

The date stays in the path because every link, every client and every `/export` URL
already carries it, and dropping it would break them all to save a segment. The same goes
for `plan-ids` on `/api/workout-plans` and for the `date` argument of a tool: given,
ignored, and the id decides. `get_workout` is the one exception, because a date with no
id is a question about the day rather than a way of naming a workout.

The retention window is unaffected: it is applied to the date the row is *stored* with,
so a workout that has aged out is invisible whichever address is used to ask for it.

## The routes outside `/api/`

Two carry their own authentication, and so must not meet `withUser`:
`/webhooks/intervals`, authenticated by the secrets intervals.icu sends (see
[integrations.md](integrations.md)), and
`/downloads/completed-workouts.zip`, authenticated by a signature naming the athlete and
the range, expiring after four hours — the point of it is to be followable by something
holding no account at all (see [recordings.md](recordings.md)). Everything else outside
`/api/` is the dashboard.

`/api/app-token` is the one path under `/api/` the session cookie does not reach: it is
registered on the OAuth provider, which understands bearer tokens and nothing else. It
exists so an app that has just done the browser round trip can trade its grant for the
credential the rest of this table takes. See
["A native app signs in through the browser"](auth.md#a-native-app-signs-in-through-the-browser-and-ends-up-with-a-token).

## Authentication before existence

Under `/api/` and `/export/`, an unknown path is answered the way a known one would be:
**401 before 404 or 405**, so a caller without a credential cannot map the API by reading
status codes back.

## Reading a week of plans at once

`/api/workout-plans` takes every plan in one call because the client that wants them
wants a week: a route per workout was a request, an authentication and a read each, and a
watch app syncing a fortnight spent nearly all its time on round trips. `plan-ids` is a
comma-separated list of `YYYY-MM-DD-<id>`, at most fifty, duplicates answered once. The
day in each is the ignored one: a plan the client listed yesterday and that has moved
since is returned, on the day it is on now.

A plan that is not there is named in `missing` rather than failing the request: between
the listing a client scheduled from and the plans it asks for, a workout may have been
deleted, and one workout gone should not cost the caller the rest of the week.

`/api/me` returns the retention window because it is computed in UTC; a client deriving
it from local midnight would disagree at the edges.

## Posting a recording

`POST /api/workouts/:date/:id/recording` takes the FIT file as the request body, not JSON
and not multipart: base64 would spend a third of a Worker's budget on wrapping it.
`?activity_id=` is the caller's own name for the file, stored beside the numbers so the
same session uploaded twice is recognisable as one.

The file is decoded, reduced to the stats in [stats.md](stats.md) and dropped. The session
is marked done at the moment the recording ended unless it already carried a completion.
An unreadable body is a 400 naming what was wrong rather than a stored `source_unreadable`
— there is no pass behind an upload to retry it — and one over 8 MiB is a 413, answered
off `Content-Length` so the bytes are never buffered.

## FIT downloads

`/export` also accepts `?token=wk_...`, because a watch or a plain link cannot set a
header. That puts the token in URLs and logs — prefer the header where you can. The
dashboard fetches the bytes and hands them over as a blob, so its session credential never
lands in a URL.

## CORS

Open (`Access-Control-Allow-Origin: *`), which is safe here because authentication is a
bearer token rather than a cookie.
