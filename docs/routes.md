# Routes

`plan_route` turns a few waypoints into a track that follows real, mapped paths, so an
assistant that cannot reach a map itself can still hand an athlete a route to follow. It
reads no workout and writes nothing, and is behind sign-in only so the router is not ours
to give away.

## What it does

The waypoints go to [OSRM](https://project-osrm.org/) on FOSSGIS's public server,
`routing.openstreetmap.de`, in **one request** however many there are. Running, walking and
hiking use its foot profile; cycling uses its bike profile. `loop: true` adds the first
waypoint again at the end.

What comes back:

| Field | |
| --- | --- |
| `distance_m`, `legs` | The whole route, and each waypoint-to-waypoint leg. |
| `waypoints` | Each input, where the router moved it to (`snapped`), how far (`snap_m`) and the road it landed on. |
| `warnings` | One line for every waypoint that moved more than 30 m, and for every U-turn. |
| `turns` | Each road in order, with the turn onto it and how far along it. |
| `gpx_url`, `expires_at` | The file, behind a signed link. See below. |
| `geojson` | Only with `geojson: true`: the router's own line, for drawing on a map. |

## The track never passes through the model

A model asked to write out a file holding hundreds of six-decimal coordinates will copy
some of them wrong, and the result looks exactly as authoritative as the right one. So the
track is not in the answer at all. The answer carries a link, and the file comes from
the server when the link is followed.

```
/downloads/route.gpx?claims=<base64url>&signature=<base64url>
```

The link carries **the query, not the track**: waypoints, loop, sport, name and expiry,
signed the way the recordings link is ([recordings.md](recordings.md#the-link)), under a
label of its own. Following it routes again and streams the GPX. Nothing is stored in D1,
and the link's length depends on the waypoints, not the route: a few hundred bytes for a
handful of unnamed ones, a few KB at worst with 25 long names. The cost is a second request
to the router, and that a map edit between the two calls could move the line; the file's
own description states the distance it was built with.

**A followed link is kept at the edge** in the Workers cache until it expires, keyed on the
whole URL. The link is a bearer credential that may leak, and without the cache every
follow of a leaked one would be a request to FOSSGIS under our `User-Agent`; with it, the
router is asked at most once per Cloudflare location. The caller is still told
`Cache-Control: no-store`, because the link expires.

It lasts 24 hours and names no athlete, since routing reads nothing of theirs. What it does
reveal is the waypoints, which may be a hotel. It sits outside `/api/` for the same reason
as the recordings archive: it is meant to be opened by whatever holds no account.

`geojson` is the map's half of this. It returns OSRM's vertices without the added points,
which draws the identical line in a fraction of the size, for an assistant building a map
in a page.

## Why it says what it cannot do

The tool exists because a hand-drawn line looks exactly like a routed one, and gets
followed into traffic. So the output is built to keep that from happening downstream:

- **The router knows paths, not safety.** The foot profile happily routes along a national
  highway. `turns` carries the road names so an assistant can see a `GT Road` and say so.
- **Every real turn is kept.** A turn onto a road of the same name, which is most turns on
  unnamed park paths, is still a line. OSRM reports nothing but arrive-and-depart where a
  waypoint sits, so the turn there is read off the two bearings.
- **A far snap is reported, not hidden.** A waypoint 200 m from any path has been moved,
  and `snap_m` says by how much.
- **A U-turn is a warning.** A waypoint guessed a few hundred metres wrong usually lands
  *on* a path, just the wrong one, so `snap_m` is 0 and says nothing. What gives it away
  is the line going out to fetch the point and coming back. Every U-turn is reported: at a
  waypoint, read off the bearings either side of it, and mid-leg, where OSRM marks one at
  a dead end. A loop around a park meant as a ring has none.
- **A failure says not to improvise.** An unreachable router, or one silent for 10 s, is
  a tool error reading "no route was made, so do not approximate one". A model told only
  "error" tends to draw the line itself. Over REST it is a 502. A route OSRM refuses for
  its points (`NoRoute`, `NoSegment`, `TooBig`) is the caller's 400 instead; its other
  refusals mean our own URL was wrong, and are treated as an outage so they get logged.
- **A deployment without `CREDENTIALS_SECRET`** cannot sign the link, and says so: a 503
  over REST, and over MCP a tool error naming the binding. Both outcomes share one error
  class, `Unavailable` in `src/errors.ts`, which both error funnels answer with its own
  message.
- **No elevation.** The router has none, and `<ele>0</ele>` would read as sea level, so
  the tag is left out.

## Density

OSRM returns one vertex per OSM node, which on a straight road can be hundreds of metres
apart. The GPX adds points every 20 m or less **between consecutive vertices only**: two
consecutive vertices lie on the same way, so a point between them is on that way too.
Nothing is added anywhere else.

## Limits

At most 25 waypoints and 100 km. The waypoints' straight-line distance is checked before
the router is asked, since no route is shorter than that. FOSSGIS's servers are free and
asked to be used fairly, with a `User-Agent` naming the caller; every request sends one.
If they ever refuse us, the base URLs are two constants in `src/route.ts`, and any OSRM
server answers the same.

Coordinates are rounded to six decimal places, about 11 cm, on the way in. That is finer
than OSM itself, and it keeps a tiny value out of the exponent notation OSRM cannot parse.

Map data © OpenStreetMap contributors, under the ODbL. The attribution is in every
result's `source` and in the GPX description.
