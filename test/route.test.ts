import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOWNLOAD_PATH,
  LINK_TTL_SECONDS,
  MAX_ROUTE_KM,
  MAX_WAYPOINTS,
  SNAP_WARNING_M,
  TRACKPOINT_SPACING_M,
  densify,
  metresBetween,
} from '../src/route';
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
  gpx_url: string;
  expires_at: string;
  geojson?: { type: string; coordinates: number[][] };
};

const planned = async (args: unknown): Promise<Planned> => {
  const response = await planRoute(args);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Planned;
};

/** Followed with no credential at all, as the athlete's browser would. */
const download = (url: string) => SELF.fetch(url);

const trackpoints = (gpx: string) =>
  [...gpx.matchAll(/<trkpt lat="([\d.-]+)" lon="([\d.-]+)"/g)].map((m) => ({ lat: Number(m[1]), lon: Number(m[2]) }));

// Three corners of Company Bagh, Amritsar, roughly 400-500 m apart.
const HOTEL = { lat: 31.635809, lon: 74.878612, name: 'Hotel' };
const NORTH = { lat: 31.6400086, lon: 74.8782558 };
const EAST = { lat: 31.6393774, lon: 74.8812859, name: 'Café corner' };

beforeEach(async () => {
  await resetDatabase();
  await control('reset', {});
  ({ token } = await seedUser());
});

describe('plan_route', () => {
  it('routes a loop in one request, and keeps the track out of the answer', async () => {
    const route = await planned({ waypoints: [HOTEL, NORTH, EAST], loop: true, name: 'Company Bagh' });

    const expected = metresBetween(HOTEL, NORTH) + metresBetween(NORTH, EAST) + metresBetween(EAST, HOTEL);
    expect(route.distance_m).toBe(Math.round(expected));
    expect(route.legs.map((leg) => [leg.from, leg.to])).toEqual([[0, 1], [1, 2], [2, 0]]);
    // The closing stop is the start again, so three waypoints come back, not four.
    expect(route.waypoints.map((w) => w.name)).toEqual(['Hotel', null, 'Café corner']);
    expect(route.warnings).toEqual([]);
    expect(route.geojson).toBeUndefined();
    expect(JSON.stringify(route)).not.toContain('<trkpt');

    const requests = await routingRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].path).toBe(
      '/routed-foot/route/v1/foot/74.878612,31.635809;74.878256,31.640009;74.881286,31.639377;74.878612,31.635809',
    );
    expect(requests[0].userAgent).toContain('workouts-mcp.com');
  });

  it('hands over the GPX through a link that needs no credential', async () => {
    const route = await planned({ waypoints: [HOTEL, NORTH, EAST], loop: true, name: 'Company Bagh' });
    expect(route.gpx_url.startsWith(`${BASE}${DOWNLOAD_PATH}?claims=`)).toBe(true);
    const ttl = Date.parse(route.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan((LINK_TTL_SECONDS - 60) * 1000);

    const response = await download(route.gpx_url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/gpx+xml');
    expect(response.headers.get('Content-Disposition')).toBe('attachment; filename="Company-Bagh.gpx"');
    const gpx = await response.text();

    const points = trackpoints(gpx);
    expect(points).toHaveLength(route.trackpoints);
    for (let i = 1; i < points.length; i++) {
      expect(metresBetween(points[i - 1], points[i])).toBeLessThanOrEqual(TRACKPOINT_SPACING_M + 0.5);
    }
    expect(gpx).not.toContain('<ele>');
    expect(gpx).toContain('<wpt lat="31.635809" lon="74.878612"><name>Hotel</name></wpt>');
    expect(gpx).toContain('<name>Café corner</name>');
    expect(gpx).toContain(`${(route.distance_m / 1000).toFixed(2)} km running route`);
    expect(gpx).toContain('OpenStreetMap contributors');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    // Following the link routes again; nothing about the route was stored.
    expect(await routingRequests()).toHaveLength(2);

    // But a link followed again is answered from the edge, so a leaked one cannot drive the router.
    const again = await download(route.gpx_url);
    expect(again.status).toBe(200);
    expect(again.headers.get('Cache-Control')).toBe('no-store');
    expect(await again.text()).toBe(gpx);
    expect(await routingRequests()).toHaveLength(2);
  });

  it('names the file the way a FIT export would, accents dropped rather than split', async () => {
    const route = await planned({ waypoints: [HOTEL, EAST], name: 'Crème Brûlée Loop' });
    expect((await download(route.gpx_url)).headers.get('Content-Disposition')).toBe(
      'attachment; filename="Creme-Brulee-Loop.gpx"',
    );
  });

  it('refuses a link that was altered, or has expired', async () => {
    const route = await planned({ waypoints: [HOTEL, EAST] });
    const url = new URL(route.gpx_url);

    const tampered = new URL(url);
    tampered.searchParams.set('claims', `${url.searchParams.get('claims')}x`);
    const altered = await download(tampered.toString());
    expect(altered.status).toBe(403);
    expect(((await altered.json()) as { error: string }).error).toMatch(/altered/);

    expect((await download(`${BASE}${DOWNLOAD_PATH}`)).status).toBe(403);
  });

  it('answers the router\'s own line for a map when asked, without the added points', async () => {
    const route = await planned({ waypoints: [HOTEL, EAST], geojson: true });

    expect(route.geojson).toEqual({
      type: 'LineString',
      coordinates: [
        [74.878612, 31.635809],
        // Six decimal places, about 11 cm: finer than any map and than OSM itself.
        [74.881286, 31.639377],
      ],
    });
    expect(route.trackpoints).toBeGreaterThan(2);
  });

  it('routes cycling on the bike profile', async () => {
    await planned({ waypoints: [HOTEL, EAST], sport: 'cycling' });
    expect((await routingRequests())[0].path).toMatch(/^\/routed-bike\/route\/v1\/bike\//);
  });

  it('keeps every real turn, and reads a turn at a waypoint off the bearings', async () => {
    // North, then east: a right turn at NORTH, where OSRM itself reports only arrive and depart.
    const route = await planned({ waypoints: [HOTEL, NORTH, EAST] });

    expect(route.turns.map((t) => [t.turn, t.road])).toEqual([
      ['depart', 'Queens Road'],
      ['right', 'Mall Road'],
      ['right', 'Queens Road'],
      ['right', 'Mall Road'],
    ]);
  });

  it('warns when a waypoint had to move far to reach a way', async () => {
    await control('setup', { routingSnapMetres: SNAP_WARNING_M + 50 });
    const route = await planned({ waypoints: [HOTEL, EAST] });

    expect(route.waypoints[1].snap_m).toBe(SNAP_WARNING_M + 50);
    expect(route.warnings).toHaveLength(2);
    expect(route.warnings[1]).toMatch(/^waypoints\[1\] is 80 m from the nearest foot way/);
  });

  it('names the field it refuses, and asks the router nothing it can refuse itself', async () => {
    const refusal = async (args: unknown) => {
      const response = await planRoute(args);
      expect(response.status).toBe(400);
      return ((await response.json()) as { error: string }).error;
    };

    expect(await refusal({ waypoints: [HOTEL] })).toMatch(/^waypoints: at least 2/);
    expect(await refusal({ waypoints: [HOTEL, { lat: 95, lon: 1 }] })).toMatch(/^waypoints\[1\]\.lat: expected a number between -90 and 90/);
    expect(await refusal({ waypoints: [HOTEL, { lat: '', lon: ' ' }] })).toMatch(/^waypoints\[1\]\.lat: expected a number/);
    expect(await refusal({ waypoints: [HOTEL, [31, 74]] })).toMatch(/^waypoints\[1\]: expected/);
    expect(await refusal({ waypoints: Array(MAX_WAYPOINTS + 1).fill(HOTEL) })).toMatch(/at most 25/);
    expect(await refusal({ waypoints: [HOTEL, EAST], sport: 'swimming' })).toMatch(/^sport: expected one of/);
    expect(await refusal({ waypoints: [HOTEL, { lat: 28.6, lon: 77.2 }] })).toMatch(
      new RegExp(`^waypoints: the points alone are [\\d.]+ km apart in straight lines; at most ${MAX_ROUTE_KM} km`),
    );
    expect(await routingRequests()).toHaveLength(0);
  });

  it('passes on the router refusing the points as the caller\'s, in fixed-point coordinates', async () => {
    const response = await planRoute({ waypoints: [{ lat: 0.0000004, lon: 0.0000004 }, { lat: 0, lon: 0 }] });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      'waypoints: the foot router refused these points (NoRoute: Impossible route between points)',
    );
    expect((await routingRequests())[0].path).toBe('/routed-foot/route/v1/foot/0.000000,0.000000;0.000000,0.000000');
  });

  it('tells the model plainly when the router is down, so it does not draw one itself', async () => {
    await control('setup', { routingDown: true });
    const response = await mcpFetch(token, 'tools/call', { name: 'plan_route', arguments: { waypoints: [HOTEL, EAST] } });
    const { result } = (await response.json()) as { result: { isError: boolean; content: { text: string }[] } };

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe('the routing service answered 502; no route was made, so do not approximate one');
  });

  it('answers an outage over REST as the upstream\'s fault, not the caller\'s', async () => {
    await control('setup', { routingDown: true });
    const response = await planRoute({ waypoints: [HOTEL, EAST] });
    expect(response.status).toBe(502);
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
