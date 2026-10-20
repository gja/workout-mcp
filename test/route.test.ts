import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_WAYPOINTS, SNAP_WARNING_M, TRACKPOINT_SPACING_M, densify, metresBetween } from '../src/route';
import { mcpFetch, resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

let token: string;

const control = async (path: string, body?: unknown): Promise<Response> => {
  const response = await env.INTERVALS.fetch(`https://intervals.icu/__control/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response;
};

const routingRequests = async () =>
  ((await (await control('routing')).json()) as { requests: { path: string; search: string; userAgent: string }[] })
    .requests;

const planRoute = (args: unknown) =>
  SELF.fetch(`${BASE}/api/tools/plan_route`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });

type Planned = {
  distance_m: number;
  legs: { from: number; to: number; distance_m: number }[];
  waypoints: { name: string | null; snap_m: number; snapped: { lat: number; lon: number } }[];
  warnings: string[];
  turns: { turn: string; road: string; distance_m: number }[];
  trackpoints: number;
  filename?: string;
  gpx?: string;
  geojson?: { features: { geometry: { type: string; coordinates: number[][] | number[] } }[] };
};

// Three corners of Company Bagh, Amritsar, roughly 400-500 m apart.
const HOTEL = { lat: 31.635809, lon: 74.878612, name: 'Hotel' };
const NORTH = { lat: 31.6400086, lon: 74.8782558 };
const EAST = { lat: 31.6393774, lon: 74.8812859, name: 'NE corner' };

beforeEach(async () => {
  await resetDatabase();
  await control('reset', {});
  ({ token } = await seedUser());
});

describe('plan_route', () => {
  it('routes a loop in one request, and returns a dense GPX with no invented elevation', async () => {
    const response = await planRoute({ waypoints: [HOTEL, NORTH, EAST], loop: true, name: 'Company Bagh' });
    expect(response.status).toBe(200);
    const route = (await response.json()) as Planned;

    const expected = metresBetween(HOTEL, NORTH) + metresBetween(NORTH, EAST) + metresBetween(EAST, HOTEL);
    expect(route.distance_m).toBe(Math.round(expected));
    expect(route.legs.map((leg) => [leg.from, leg.to])).toEqual([[0, 1], [1, 2], [2, 0]]);
    // The closing stop is the start again, so three waypoints come back, not four.
    expect(route.waypoints.map((w) => w.name)).toEqual(['Hotel', null, 'NE corner']);
    expect(route.warnings).toEqual([]);

    const requests = await routingRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toMatch(/^\/routed-foot\/route\/v1\/foot\/74\.878612,31\.635809;.*;74\.878612,31\.635809$/);
    expect(requests[0].userAgent).toContain('workouts-mcp.com');

    expect(route.filename).toBe('Company-Bagh.gpx');
    const points = [...route.gpx!.matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)"/g)].map((m) => ({
      lat: Number(m[1]),
      lon: Number(m[2]),
    }));
    expect(points).toHaveLength(route.trackpoints);
    for (let i = 1; i < points.length; i++) {
      expect(metresBetween(points[i - 1], points[i])).toBeLessThanOrEqual(TRACKPOINT_SPACING_M + 0.5);
    }
    expect(route.gpx).not.toContain('<ele>');
    expect(route.gpx).toContain('<wpt lat="31.635809" lon="74.878612"><name>Hotel</name></wpt>');
    expect(route.gpx).toContain('<name>NE corner</name>');
    expect(route.gpx).toContain('OpenStreetMap contributors');
  });

  it('routes cycling on the bike profile, and merges consecutive steps on one road', async () => {
    const route = (await (await planRoute({ waypoints: [HOTEL, EAST], sport: 'cycling' })).json()) as Planned;

    expect((await routingRequests())[0].path).toMatch(/^\/routed-bike\/route\/v1\/bike\//);
    expect(route.turns.map((t) => [t.turn, t.road])).toEqual([
      ['depart', 'Queens Road'],
      ['right', 'Mall Road'],
    ]);
  });

  it('answers GeoJSON for a map, in lon,lat order', async () => {
    const route = (await (await planRoute({ waypoints: [HOTEL, EAST], format: 'geojson' })).json()) as Planned;

    expect(route.gpx).toBeUndefined();
    const [line, start] = route.geojson!.features;
    expect(line.geometry.type).toBe('LineString');
    expect((line.geometry.coordinates as number[][])[0]).toEqual([HOTEL.lon, HOTEL.lat]);
    expect(start.geometry.coordinates).toEqual([HOTEL.lon, HOTEL.lat]);
  });

  it('warns when a waypoint had to move far to reach a way', async () => {
    await control('setup', { routingSnapMetres: SNAP_WARNING_M + 50 });
    const route = (await (await planRoute({ waypoints: [HOTEL, EAST] })).json()) as Planned;

    expect(route.waypoints[1].snap_m).toBe(SNAP_WARNING_M + 50);
    expect(route.warnings).toHaveLength(2);
    expect(route.warnings[1]).toMatch(/^waypoints\[1\] is 80 m from the nearest foot way/);
  });

  it('names the field it refuses', async () => {
    const refusal = async (args: unknown) => {
      const response = await planRoute(args);
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };

    expect(await refusal({ waypoints: [HOTEL] })).toMatch(/^waypoints: at least 2/);
    expect(await refusal({ waypoints: [HOTEL, { lat: 95, lon: 1 }] })).toMatch(/^waypoints\[1\]\.lat: expected a number between -90 and 90/);
    expect(await refusal({ waypoints: [HOTEL, [31, 74]] })).toMatch(/^waypoints\[1\]: expected/);
    expect(await refusal({ waypoints: Array(MAX_WAYPOINTS + 1).fill(HOTEL) })).toMatch(/at most 25/);
    expect(await refusal({ waypoints: [HOTEL, EAST], sport: 'swimming' })).toMatch(/^sport: expected one of/);
    expect(await refusal({ waypoints: [HOTEL, { lat: 0, lon: 0 }] })).toMatch(/^waypoints: no foot route joins/);
    expect(await routingRequests()).toHaveLength(1);
  });

  it('tells the model plainly when the router is down, so it does not draw one itself', async () => {
    await control('setup', { routingDown: true });
    const response = await mcpFetch(token, 'tools/call', { name: 'plan_route', arguments: { waypoints: [HOTEL, EAST] } });
    const { result } = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      'the routing service answered 502; no route was made, so do not approximate one',
    );
  });
});

describe('densify', () => {
  it('keeps the vertices and adds points only between them', () => {
    const a = { lat: 31.6, lon: 74.8 };
    const b = { lat: 31.6, lon: 74.801 };
    const dense = densify([a, b], 20);

    expect(dense[0]).toEqual(a);
    expect(dense[dense.length - 1]).toEqual(b);
    expect(dense).toHaveLength(Math.ceil(metresBetween(a, b) / 20) + 1);
  });
});
