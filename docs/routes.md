# Routes

`plan_route` turns a few waypoints into a track that follows real, mapped paths, so an
assistant that cannot reach a map itself can still hand an athlete a route to follow. It
is the one tool that knows nothing about the athlete: it reads no workout and writes
nothing, and is behind sign-in only so the router is not ours to give away.

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
| `warnings` | One line for every waypoint that moved more than 30 m. |
| `turns` | The road names in order, with the turn onto each and how far along it. |
| `gpx` + `filename`, or `geojson` | The track, by `format`. |

## Why it says what it cannot do

The reason the tool exists is that a hand-drawn line looks exactly like a routed one and
gets followed into traffic. So the output is built to keep that from happening downstream:

- **The router knows paths, not safety.** The foot profile happily routes along a national
  highway. `turns` carries the road names so an assistant can see a `GT Road` and say so;
  the description tells it to judge traffic, surface and safety from them.
- **A far snap is reported, not hidden.** A waypoint 200 m from any path has been moved,
  and `snap_m` says by how much.
- **A failure says not to improvise.** An unreachable router is a tool error whose text
  is "no route was made, so do not approximate one". A model told only "error" tends to
  draw the line itself.
- **No elevation.** The router has none, and `<ele>0</ele>` would read as sea level, so
  the tag is left out.

## Density

OSRM returns one vertex per OSM node, which on a straight road can be hundreds of metres
apart. Points are added every 20 m or less **between consecutive vertices only**: two
consecutive vertices lie on the same way, so a point between them is on that way too.
Nothing is added anywhere else.

## Limits

At most 25 waypoints and 100 km. FOSSGIS's servers are free and asked to be used fairly,
with a `User-Agent` naming the caller; every request sends one. If they ever refuse us,
the base URLs are two constants in `src/route.ts`, and any OSRM server answers the same.

Map data © OpenStreetMap contributors, under the ODbL. The attribution is in every
result's `source` and in the GPX description.
