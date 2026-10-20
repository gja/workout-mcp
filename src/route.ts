// A route snapped to OpenStreetMap ways, from a handful of waypoints. See docs/routes.md.

import { fail } from './units';

export const MAX_WAYPOINTS = 25;
export const MAX_ROUTE_KM = 100;
/** Trackpoints are at most this far apart; see docs/routes.md#density. */
export const TRACKPOINT_SPACING_M = 20;
/** A waypoint moved further than this to reach a way is reported as a warning. */
export const SNAP_WARNING_M = 30;

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

export const ROUTE_FORMATS = ['gpx', 'geojson'] as const;
export type RouteFormat = (typeof ROUTE_FORMATS)[number];

const USER_AGENT = 'workouts-mcp.com (+https://github.com/gja/workout-mcp)';
const ATTRIBUTION = '© OpenStreetMap contributors, ODbL; routed by OSRM at routing.openstreetmap.de';

type Point = { lat: number; lon: number };
type Waypoint = Point & { name?: string };

export type RouteQuery = {
  waypoints: Waypoint[];
  loop: boolean;
  sport: RouteSport;
  format: RouteFormat;
  name: string;
};

export class RouteUnavailable extends Error {}

const QUERY_KEYS = new Set(['waypoints', 'loop', 'sport', 'format', 'name']);

function parseCoordinate(value: unknown, path: string, limit: number): number {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > limit) {
    fail(path, `expected a number between -${limit} and ${limit}, got ${JSON.stringify(value)}`);
  }
  return n as number;
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

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(path, `expected one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

export function parseRouteQuery(args: Record<string, unknown>): RouteQuery {
  const unknown = Object.keys(args).filter((key) => !QUERY_KEYS.has(key));
  if (unknown.length > 0) fail('', `unknown field ${unknown.join(', ')}; allowed: ${[...QUERY_KEYS].join(', ')}`);

  if (!Array.isArray(args.waypoints)) fail('waypoints', 'expected an array of {"lat", "lon"} points');
  const raw = args.waypoints as unknown[];
  const loop = args.loop === undefined || args.loop === null ? false : args.loop;
  if (typeof loop !== 'boolean') fail('loop', 'expected true or false');
  if (raw.length < 2) fail('waypoints', `at least 2 are needed, got ${raw.length}`);
  if (raw.length > MAX_WAYPOINTS) fail('waypoints', `at most ${MAX_WAYPOINTS}, got ${raw.length}`);

  const name = args.name === undefined || args.name === null ? '' : args.name;
  if (typeof name !== 'string') fail('name', `expected a string, got ${typeof name}`);

  return {
    waypoints: raw.map((point, i) => parseWaypoint(point, `waypoints[${i}]`)),
    loop: loop as boolean,
    sport: oneOf(args.sport, 'sport', ROUTE_SPORTS, 'running'),
    format: oneOf(args.format, 'format', ROUTE_FORMATS, 'gpx'),
    name: (name as string).trim().slice(0, 80) || 'Route',
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

type OsrmStep = { name: string; distance: number; maneuver: { type: string; modifier?: string } };
type OsrmResponse = {
  code: string;
  message?: string;
  routes?: {
    distance: number;
    geometry: { coordinates: [number, number][] };
    legs: { distance: number; steps: OsrmStep[] }[];
  }[];
  waypoints?: { location: [number, number]; distance: number; name: string }[];
};

/** One request for the whole route, however many waypoints: OSRM takes them all at once. */
async function askRouter(query: RouteQuery, stops: Waypoint[]): Promise<OsrmResponse> {
  const coordinates = stops.map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `${PROFILES[PROFILE[query.sport]]}${coordinates}?overview=full&geometries=geojson&steps=true`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  } catch (err) {
    throw new RouteUnavailable(`could not reach the routing service (${(err as Error).message})`);
  }
  // OSRM answers a route it cannot find with a 400 and a code, which is about the input.
  const body = (await response.json().catch(() => null)) as OsrmResponse | null;
  if (body?.code === 'NoRoute' || body?.code === 'NoSegment') {
    fail('waypoints', `no ${PROFILE[query.sport]} route joins these points${body.message ? `: ${body.message}` : ''}`);
  }
  if (!response.ok || !body || body.code !== 'Ok' || !body.routes?.length || !body.waypoints) {
    throw new RouteUnavailable(`the routing service answered ${response.status}${body?.code ? ` (${body.code})` : ''}`);
  }
  return body;
}

/** "turn left", "continue", "arrive": OSRM's maneuver, in the words a turn list wants. */
const turnOf = ({ type, modifier }: OsrmStep['maneuver']): string => {
  if (type === 'depart' || type === 'arrive') return type;
  if (type === 'roundabout' || type === 'rotary') return 'roundabout';
  return modifier ?? type;
};

/** Consecutive steps on one road are one line of a turn list; a waypoint passed through is not a turn. */
function turnList(legs: { steps: OsrmStep[] }[]) {
  const turns: { turn: string; road: string; distance_m: number }[] = [];
  legs.forEach((leg, i) => {
    for (const step of leg.steps) {
      if (step.maneuver.type === 'arrive') continue;
      const road = step.name || '(unnamed)';
      const last = turns[turns.length - 1];
      const passing = step.maneuver.type === 'depart' && i > 0;
      if (last && last.road === road && (passing || step.maneuver.type !== 'depart')) last.distance_m += step.distance;
      else turns.push({ turn: passing ? `via waypoints[${i}]` : turnOf(step.maneuver), road, distance_m: step.distance });
    }
  });
  return turns.map((t) => ({ ...t, distance_m: roundM(t.distance_m) }));
}

export async function planRoute(query: RouteQuery) {
  const stops = query.loop ? [...query.waypoints, query.waypoints[0]] : query.waypoints;
  const body = await askRouter(query, stops);
  const route = body.routes![0];

  if (route.distance > MAX_ROUTE_KM * 1000) {
    fail('waypoints', `the route is ${(route.distance / 1000).toFixed(1)} km; at most ${MAX_ROUTE_KM} km`);
  }

  const track = densify(route.geometry.coordinates.map(([lon, lat]) => ({ lat, lon }))).map((p) => ({
    lat: round6(p.lat),
    lon: round6(p.lon),
  }));

  // The closing stop of a loop is the start again, so it is not reported twice.
  const count = query.waypoints.length;
  const snapped = body.waypoints!.slice(0, count).map((w, i) => ({
    name: stops[i].name ?? null,
    input: { lat: stops[i].lat, lon: stops[i].lon },
    snapped: { lat: round6(w.location[1]), lon: round6(w.location[0]) },
    snap_m: roundM(w.distance),
    road: w.name || null,
  }));
  const warnings = snapped
    .filter((w) => w.snap_m > SNAP_WARNING_M)
    .map((w) => `waypoints[${snapped.indexOf(w)}] is ${w.snap_m} m from the nearest ${PROFILE[query.sport]} way, and was moved onto it`);

  const result = {
    name: query.name,
    sport: query.sport,
    distance_m: roundM(route.distance),
    legs: route.legs.map((leg, i) => ({ from: i, to: (i + 1) % count, distance_m: roundM(leg.distance) })),
    waypoints: snapped,
    warnings,
    turns: turnList(route.legs),
    trackpoints: track.length,
    source: ATTRIBUTION,
  };

  return query.format === 'geojson'
    ? { ...result, geojson: toGeoJson(track, snapped, result) }
    : { ...result, filename: `${slug(query.name)}.gpx`, gpx: toGpx(track, snapped, result) };
}

// --- Output ------------------------------------------------------------------

const slug = (name: string) => name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

type Summary = { name: string; sport: RouteSport; distance_m: number };
type Snapped = { name: string | null; snapped: Point }[];

const describe = (summary: Summary) =>
  `${(summary.distance_m / 1000).toFixed(2)} km ${summary.sport} route. ${ATTRIBUTION}.`;

/** No <ele>: a route says nothing about height, and a zero would be read as sea level. */
export function toGpx(track: Point[], waypoints: Snapped, summary: Summary): string {
  const named = waypoints.filter((w, i) => w.name !== null || i === 0);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="workouts-mcp.com" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${escapeXml(summary.name)}</name><desc>${escapeXml(describe(summary))}</desc></metadata>`,
    ...named.map(
      (w) => `<wpt lat="${w.snapped.lat}" lon="${w.snapped.lon}"><name>${escapeXml(w.name ?? 'Start')}</name></wpt>`,
    ),
    `<trk><name>${escapeXml(summary.name)}</name><type>${summary.sport}</type><trkseg>`,
    ...track.map((p) => `<trkpt lat="${p.lat}" lon="${p.lon}"/>`),
    '</trkseg></trk>',
    '</gpx>',
  ].join('\n');
}

export function toGeoJson(track: Point[], waypoints: Snapped, summary: Summary) {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { name: summary.name, sport: summary.sport, distance_m: summary.distance_m },
        geometry: { type: 'LineString', coordinates: track.map((p) => [p.lon, p.lat]) },
      },
      ...waypoints.map((w, i) => ({
        type: 'Feature',
        properties: { name: w.name, index: i },
        geometry: { type: 'Point', coordinates: [w.snapped.lon, w.snapped.lat] },
      })),
    ],
  };
}
