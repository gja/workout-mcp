# HTTP API

Authenticate with `Authorization: Bearer <token>` or, from a browser, the
session cookie set at login.

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
| `DELETE /api/tokens/:prefix` | Revoke one |
| `GET /api/connections` | List OAuth grants (connected MCP clients) |
| `DELETE /api/connections/:id` | Disconnect one |
| `GET /api/workouts.json?from=&to=` | List within the retention window; a wider range is narrowed to it |
| `POST /api/workouts` | Create; returns the id and URLs |
| `GET /api/workouts/:date/:id.json` | Read one |
| `PUT /api/workouts/:date/:id.json` | Replace one; change `date` to move it |
| `DELETE /api/workouts/:date/:id.json` | Delete one |
| `POST /api/workouts/:date/:id/complete` | Mark it done; `{completed_at}` optional, defaults to now |
| `DELETE /api/workouts/:date/:id/complete` | Clear that, leaving the plan alone |
| `GET /api/library` | The workout library an assistant reads, and whether it is the athlete's own |
| `PUT /api/library` | `{markdown}` — replace it; an empty document means "use the built-in one" |
| `DELETE /api/library` | Forget the athlete's own, going back to the built-in library |
| `GET /api/config` | Every integration and where each one stands |
| `PUT /api/config/:integration` | Answers 400: a platform is connected by OAuth, not by a body |
| `DELETE /api/config/:integration` | Disconnect, forgetting what was stored for it |
| `POST /api/sync/:integration` | Run that integration's sync now |
| `GET /api/recordings?platform=&from=&to=&sport=` | Sessions you actually recorded, and a signed link to their files |
| `GET /export/:date-:id.fit` | The FIT file |
| `POST /api/tools/:name` | Any MCP tool, over REST |
| `POST /webhooks/intervals` | intervals.icu's own callback; theirs to call, not yours |
| `GET /downloads/completed-workouts.zip?claims=&signature=` | Those files as one ZIP. No auth: the signature is the credential |

`:integration` is a training platform's id (`intervals`). One read covers the
lot, and each Setup panel takes its own slice. A platform has no `PUT` body
because it is connected by an OAuth round — the two `/auth/intervals/connect*`
routes above — so that path answers 400 and says so.

Two routes sit outside `/api/` without being the dashboard, and both
deliberately, because both carry their own authentication and so must not meet
`withUser`:

- `/webhooks/intervals` is authenticated by the secrets intervals.icu sends
  rather than by a credential of ours. See [integrations.md](integrations.md).
- `/downloads/completed-workouts.zip` is authenticated by its own signature,
  which names the athlete and the range and expires after four hours. The point
  of it is to be followable by something holding no account at all — an
  assistant, a browser, `curl`. See [recordings.md](recordings.md).

Everything else outside `/api/` is the dashboard.

Syncing is under `/api/sync`, not `/api/config`: configuring an integration and
telling it to run now are different things, and only the first is a setting.
Nothing has to call it — every integration syncs on its own schedule (see
[integrations.md](integrations.md)) — it is the
dashboard's "Sync now" and "Copy now" buttons, for when waiting for the next
pass is not what you want.

A date may hold several workouts; each gets its own short id.

`/api/library` is the only way to change the library: MCP reads it and cannot
write it, for the reason [library.md](library.md) gives.

`.json` is a second spelling of any `/api/` path, for a browser or a `curl`
that wants to name the format. It is stripped before routing, so each route is
declared once.

`/api/me` returns the retention window because it is computed in UTC: a client
deriving it from its own local midnight would disagree at the edges and drop a
workout the server legitimately returned.

## Authentication before existence

Under `/api/` and `/export/`, an unknown or wrongly-addressed path is answered
the way a known one would be: **401 before 404 or 405**, so a caller without a
credential cannot map the API by reading status codes back. Everywhere else, a
path the routing table does not claim is the dashboard.

## FIT downloads

`/export` also accepts `?token=wk_...` as a query parameter, because a watch or
a plain link cannot set an `Authorization` header. That does put the token in
URLs and server logs — prefer the header where you can, as the dashboard does.
The dashboard fetches the bytes and hands them to the browser as a blob, so its
session credential never lands in a URL or a history entry.

## CORS

Open (`Access-Control-Allow-Origin: *`), which is safe here because
authentication is a bearer token rather than a cookie.
