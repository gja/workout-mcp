// A route snapped to OpenStreetMap ways, from a handful of waypoints, and the signed link
// that hands it over as a GPX file. Nothing is stored. See docs/routes.md.

import type { Env } from './db';
import { fileSlug } from './fit';
import { Unavailable } from './errors';
import * as signing from './signing';
import { LinkRejected } from './signing';
import { fail } from './units';

export const MAX_WAYPOINTS = 25;
export const MAX_ROUTE_KM = 100;
/** Trackpoints are at most this far apart; see docs/routes.md#density. */
export const TRACKPOINT_SPACING_M = 20;
/** A waypoint moved further than this to reach a way is reported as a warning. */
export const SNAP_WARNING_M = 30;
export const LINK_TTL_SECONDS = 24 * 3600;
export const ROUTER_TIMEOUT_MS = 10_000;
export const DOWNLOAD_PATH = '/downloads/route.gpx';

/** FOSSGIS's public OSRM, one profile per mode of travel. Their usage policy asks for a User-Agent. */
const PROFILES = {
  foot: 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/',
  bike: 'https://routing.openstreetmap.de/routed-bike/route/v1/bike/',
} as const;

export const ROUTE_SPORTS = ['running', 'walking', 'hiking', 'cycling'] as const;
export type RouteSport = (typeof ROUTE_SPORTS)[number];

const PROFILE: Record<RouteSport, keyof typeof PROFILES> = {
  running: 'foot',
  walking: 'foot',
  hiking: 'foot',
  cycling: 'bike',
};

/**
 * OSRM's codes for a request it understood and could not serve: the points, not the server.
 * InvalidQuery and the like mean our URL was wrong, which is ours to hear about, not theirs.
 */
const REFUSED_POINTS = new Set(['NoRoute', 'NoSegment', 'TooBig']);

const USER_AGENT = 'workouts-mcp.com (+https://github.com/gja/workout-mcp)';
const ATTRIBUTION = '© OpenStreetMap contributors, ODbL; routed by OSRM at routing.openstreetmap.de';
const LABEL = 'workout-mcp/route-download/v1';

type Point = { lat: number; lon: number };
type Waypoint = Point & { name?: string };

export type RouteQuery = {
  waypoints: Waypoint[];
  loop: boolean;
  sport: RouteSport;
  name: string;
  geojson: boolean;
};

/** The router failed rather than refused: said as such, so nobody draws the line by hand. */
export class RouteUnavailable extends Unavailable {
  constructor(reason: string) {
    super(`${reason}; no route was made, so do not approximate one`, 502);
  }
}

const QUERY_KEYS = new Set(['waypoints', 'loop', 'sport', 'name', 'geojson']);

function parseCoordinate(value: unknown, path: string, limit: number): number {
  // Number('') is 0, which would put a blank on the equator.
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > limit) {
    fail(path, `expected a number between -${limit} and ${limit}, got ${JSON.stringify(value)}`);
  }
  return Math.round((n as number) * 1e6) / 1e6;
}

function parseWaypoint(value: unknown, path: string): Waypoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(path, 'expected {"lat": ..., "lon": ...}');
  }
  const raw = value as Record<string, unknown>;
  const point: Waypoint = {
    lat: parseCoordinate(raw.lat, `${path}.lat`, 90),
    lon: parseCoordinate(raw.lon, `${path}.lon`, 180),
  };
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') fail(`${path}.name`, `expected a string, got ${typeof raw.name}`);
    if ((raw.name as string).trim()) point.name = (raw.name as string).trim().slice(0, 80);
  }
  return point;
}

function parseFlag(value: unknown, path: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') fail(path, 'expected true or false');
  return value as boolean;
}

export function parseRouteQuery(args: Record<string, unknown>): RouteQuery {
  const unknown = Object.keys(args).filter((key) => !QUERY_KEYS.has(key));
  if (unknown.length > 0) fail('', `unknown field ${unknown.join(', ')}; allowed: ${[...QUERY_KEYS].join(', ')}`);

  if (!Array.isArray(args.waypoints)) fail('waypoints', 'expected an array of {"lat", "lon"} points');
  const raw = args.waypoints as unknown[];
  if (raw.length < 2) fail('waypoints', `at least 2 are needed, got ${raw.length}`);
  if (raw.length > MAX_WAYPOINTS) fail('waypoints', `at most ${MAX_WAYPOINTS}, got ${raw.length}`);

  const sport = args.sport === undefined || args.sport === null ? 'running' : args.sport;
  if (typeof sport !== 'string' || !(ROUTE_SPORTS as readonly string[]).includes(sport)) {
    fail('sport', `expected one of ${ROUTE_SPORTS.join(', ')}, got ${JSON.stringify(args.sport)}`);
  }
  const name = args.name === undefined || args.name === null ? '' : args.name;
  if (typeof name !== 'string') fail('name', `expected a string, got ${typeof name}`);

  return {
    waypoints: raw.map((point, i) => parseWaypoint(point, `waypoints[${i}]`)),
    loop: parseFlag(args.loop, 'loop'),
    sport: sport as RouteSport,
    name: (name as string).trim().slice(0, 80) || 'Route',
    geojson: parseFlag(args.geojson, 'geojson'),
  };
}

// --- Geometry ----------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_000;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

export function metresBetween(a: Point, b: Point): number {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** Points added only along a segment between two of the router's vertices, which lie on one way. */
export function densify(points: Point[], spacing = TRACKPOINT_SPACING_M): Point[] {
  const out = points.slice(0, 1);
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const parts = Math.max(1, Math.ceil(metresBetween(a, b) / spacing));
    for (let j = 1; j <= parts; j++) {
      out.push({ lat: a.lat + ((b.lat - a.lat) * j) / parts, lon: a.lon + ((b.lon - a.lon) * j) / parts });
    }
  }
  return out;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const roundM = (n: number) => Math.round(n);

// --- The router --------------------------------------------------------------

type Maneuver = { type: string; modifier?: string; bearing_before: number; bearing_after: number };
type OsrmStep = { name: string; distance: number; maneuver: Maneuver };
type OsrmLeg = { distance: number; steps: OsrmStep[] };
type OsrmResponse = {
  code: string;
  message?: string;
  routes?: { distance: number; geometry: { coordinates: [number, number][] }; legs: OsrmLeg[] }[];
  waypoints?: { location: [number, number]; distance: number; name: string }[];
};

/** One request for the whole route, however many waypoints: OSRM takes them all at once. */
async function askRouter(sport: RouteSport, stops: Waypoint[]): Promise<OsrmResponse> {
  // Fixed-point, because a default number string can be "5e-7", which OSRM cannot parse.
  const coordinates = stops.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const url = `${PROFILES[PROFILE[sport]]}${coordinates}?overview=full&geometries=geojson&steps=true`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(ROUTER_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = (err as Error).name === 'TimeoutError';
    throw new RouteUnavailable(
      timedOut
        ? `the routing service did not answer within ${ROUTER_TIMEOUT_MS / 1000} s`
        : `could not reach the routing service (${(err as Error).message})`,
    );
  }
  const body = (await response.json().catch(() => null)) as OsrmResponse | null;
  if (body && REFUSED_POINTS.has(body.code)) {
    fail('waypoints', `the ${PROFILE[sport]} router refused these points (${body.code}${body.message ? `: ${body.message}` : ''})`);
  }
  if (!response.ok || !body || body.code !== 'Ok' || !body.routes?.length || !body.waypoints) {
    throw new RouteUnavailable(`the routing service answered ${response.status}${body?.code ? ` (${body.code})` : ''}`);
  }
  return body;
}

/** A change of heading in words: positive is clockwise, so to the right. */
function headingChange(before: number, after: number): string {
  const delta = ((after - before + 540) % 360) - 180;
  const side = delta > 0 ? 'right' : 'left';
  const size = Math.abs(delta);
  if (size < 20) return 'straight';
  if (size < 60) return `slight ${side}`;
  if (size < 140) return side;
  return 'uturn';
}

const turnOf = ({ type, modifier }: Maneuver): string => {
  if (type === 'depart') return 'depart';
  if (type === 'roundabout' || type === 'rotary') return 'roundabout';
  return modifier ?? type;
};

/**
 * Road by road. A real turn always starts a line, even onto a road of the same name; a
 * waypoint passed through is a turn only if the heading changes there, which OSRM leaves
 * to be read off the arriving and departing bearings.
 */
function turnList(legs: OsrmLeg[]) {
  const turns: { turn: string; road: string; distance_m: number }[] = [];
  let arrivedHeading: number | null = null;
  for (const leg of legs) {
    for (const step of leg.steps) {
      const { type } = step.maneuver;
      if (type === 'arrive') {
        arrivedHeading = step.maneuver.bearing_before;
        continue;
      }
      const road = step.name || '(unnamed)';
      const turn =
        type === 'depart' && arrivedHeading !== null
          ? headingChange(arrivedHeading, step.maneuver.bearing_after)
          : turnOf(step.maneuver);
      const last = turns[turns.length - 1];
      if (last && last.road === road && turn === 'straight') last.distance_m += step.distance;
      else turns.push({ turn, road, distance_m: step.distance });
    }
  }
  return turns.map((t) => ({ ...t, distance_m: roundM(t.distance_m) }));
}

const stopsOf = (query: RouteQuery): Waypoint[] => (query.loop ? [...query.waypoints, query.waypoints[0]] : query.waypoints);

/** The routed distance is never shorter than the straight lines, so these never need asking. */
function refuseTooLong(stops: Point[]): void {
  let crow = 0;
  for (let i = 1; i < stops.length; i++) crow += metresBetween(stops[i - 1], stops[i]);
  if (crow > MAX_ROUTE_KM * 1000) {
    fail('waypoints', `the points alone are ${(crow / 1000).toFixed(1)} km apart in straight lines; at most ${MAX_ROUTE_KM} km`);
  }
}

async function route(query: RouteQuery) {
  const stops = stopsOf(query);
  refuseTooLong(stops);
  const body = await askRouter(query.sport, stops);
  const found = body.routes![0];
  if (found.distance > MAX_ROUTE_KM * 1000) {
    fail('waypoints', `the route is ${(found.distance / 1000).toFixed(1)} km; at most ${MAX_ROUTE_KM} km`);
  }

  // The closing stop of a loop is the start again, so it is not reported twice.
  const count = query.waypoints.length;
  const waypoints = body.waypoints!.slice(0, count).map((w, i) => ({
    name: stops[i].name ?? null,
    input: { lat: stops[i].lat, lon: stops[i].lon },
    snapped: { lat: round6(w.location[1]), lon: round6(w.location[0]) },
    snap_m: roundM(w.distance),
    road: w.name || null,
  }));
  const vertices = found.geometry.coordinates.map(([lon, lat]) => ({ lat: round6(lat), lon: round6(lon) }));
  const track = densify(vertices).map((p) => ({ lat: round6(p.lat), lon: round6(p.lon) }));

  return {
    summary: {
      name: query.name,
      sport: query.sport,
      distance_m: roundM(found.distance),
      legs: found.legs.map((leg, i) => ({ from: i, to: (i + 1) % count, distance_m: roundM(leg.distance) })),
      waypoints,
      warnings: waypoints.flatMap((w, i) =>
        w.snap_m > SNAP_WARNING_M
          ? [`waypoints[${i}] is ${w.snap_m} m from the nearest ${PROFILE[query.sport]} way, and was moved onto it`]
          : [],
      ),
      turns: turnList(found.legs),
      trackpoints: track.length,
      source: ATTRIBUTION,
    },
    vertices,
    track,
  };
}

/** What the tool answers: the route in numbers, a link to the file, and the line only if a map wants it. */
export async function planRoute(env: Env, query: RouteQuery, origin: string, now: Date = new Date()) {
  const { summary, vertices } = await route(query);
  const link = await signLink(env, query, origin, now);
  return {
    ...summary,
    gpx_url: link.url,
    expires_at: link.expires_at,
    ...(query.geojson ? { geojson: toGeoJson(vertices) } : {}),
  };
}

// --- The signed link ---------------------------------------------------------

/** The query, not the track: a link stays small, and following it routes again. */
type Claims = {
  /** Waypoints as [lat, lon] or [lat, lon, name]. */
  w: ([number, number] | [number, number, string])[];
  l?: 1;
  s: RouteSport;
  n: string;
};

function signLink(env: Env, query: RouteQuery, origin: string, now: Date) {
  const claims: Claims = {
    w: query.waypoints.map((p) => (p.name ? [p.lat, p.lon, p.name] : [p.lat, p.lon])),
    ...(query.loop ? { l: 1 as const } : {}),
    s: query.sport,
    n: query.name,
  };
  return signing.signLink(env, LABEL, { origin, path: DOWNLOAD_PATH, ttlSeconds: LINK_TTL_SECONDS, now }, claims);
}

/** The file a link names, routed afresh. Its claims are re-parsed: signed is not the same as valid. */
export async function downloadGpx(
  env: Env,
  claimsParam: string | null,
  signatureParam: string | null,
  now: Date = new Date(),
): Promise<{ filename: string; gpx: string; expiresAt: Date }> {
  const claims = (await signing.openLink(env, LABEL, claimsParam, signatureParam, now)) as Partial<Claims>;
  if (!Array.isArray(claims.w) || !claims.w.every(Array.isArray)) throw new LinkRejected(signing.OLDER_VERSION);

  const query = parseRouteQuery({
    waypoints: claims.w.map(([lat, lon, name]) => ({ lat, lon, name })),
    loop: claims.l === 1,
    sport: claims.s,
    name: claims.n,
  });
  const { summary, track } = await route(query);
  return {
    filename: `${fileSlug(query.name) || 'route'}.gpx`,
    gpx: toGpx(track, summary),
    expiresAt: new Date((claims as { x: number }).x * 1000),
  };
}

// --- Output ------------------------------------------------------------------

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

type Summary = Awaited<ReturnType<typeof route>>['summary'];

/** No <ele>: a route says nothing about height, and a zero would be read as sea level. */
export function toGpx(track: Point[], summary: Summary): string {
  const desc = `${(summary.distance_m / 1000).toFixed(2)} km ${summary.sport} route. ${ATTRIBUTION}.`;
  const marked = summary.waypoints.filter((w, i) => w.name !== null || i === 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="workouts-mcp.com" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${escapeXml(summary.name)}</name><desc>${escapeXml(desc)}</desc></metadata>`,
    ...marked.map(
      (w) => `<wpt lat="${w.snapped.lat}" lon="${w.snapped.lon}"><name>${escapeXml(w.name ?? 'Start')}</name></wpt>`,
    ),
    `<trk><name>${escapeXml(summary.name)}</name><type>${summary.sport}</type><trkseg>`,
    ...track.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"/>`),
    '</trkseg></trk>',
    '</gpx>',
  ].join('\n');
}

/** The router's own vertices: the same line as the file, without the points a map does not need. */
const toGeoJson = (vertices: Point[]) => ({
  type: 'LineString',
  coordinates: vertices.map((p) => [p.lon, p.lat]),
});
