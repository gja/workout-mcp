# HTTP API

Authenticate with `Authorization: Bearer <token>` or, from a browser, the
session cookie set at login.

| Route | Does |
| --- | --- |
| `GET /api/health` | Liveness, no auth |
| `GET /auth/providers` | Which sign-in providers are configured |
| `GET /auth/:provider/start` | Begin a Google or Apple sign-in |
| `GET`/`POST /auth/:provider/callback` | Finish it, sets the session cookie |
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
| `GET /api/config` | Every integration and where each one stands |
| `PUT /api/config/:integration` | Verify a credential or a drive, store it, and sync |
| `DELETE /api/config/:integration` | Disconnect, forgetting what was stored for it |
| `POST /api/sync/:integration` | Run that integration's sync now |
| `GET /export/:date-:id.fit` | The FIT file |
| `POST /api/tools/:name` | Any MCP tool, over REST |

`:integration` is a training platform's id (`intervals`) or `drive`. One read
covers the lot, and each Setup panel takes its own slice; the three verbs are
the same shape whatever is behind them, except for the body `PUT` takes — a
platform wants `{key}`, the drive wants `{drive}`, a shared drive link or id.

Syncing is under `/api/sync`, not `/api/config`: configuring an integration and
telling it to run now are different things, and only the first is a setting.
Nothing has to call it — every integration syncs on its own schedule (see
[integrations.md](integrations.md) and [drive.md](drive.md)) — it is the
dashboard's "Sync now" and "Copy now" buttons, for when waiting for the next
pass is not what you want.

A date may hold several workouts; each gets its own short id.

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
