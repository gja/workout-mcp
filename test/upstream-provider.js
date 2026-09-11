/**
 * The outside world, as an auxiliary Worker that Miniflare routes all outbound
 * traffic to. Two hosts are stood in for:
 *
 *   - Google's and Apple's token endpoints, so the Worker under test runs the
 *     real `arctic` code path — Apple's ES256 client-secret JWT included —
 *     without touching the network. The response is chosen by the `code` the
 *     test hands to the callback, so no shared state is needed for those.
 *
 *   - intervals.icu, which does need state: a test pushes a workout and then
 *     asks what landed on the calendar. That state is reachable from a test
 *     through the `INTERVALS` service binding, under `/__control`.
 */

const base64url = (value) => btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const idToken = (claims) =>
  `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}.not-a-signature`;

const GOOGLE = {
  issuer: 'https://accounts.google.com',
  audience: 'test-google-client.apps.googleusercontent.com',
  subject: 'google-user-1',
  email: 'athlete@example.com',
};

const APPLE = {
  issuer: 'https://appleid.apple.com',
  audience: 'com.example.workouts',
  subject: 'apple-user-1',
  email: 'athlete@privaterelay.appleid.com',
};

async function signIn(request, url) {
  const provider = url.hostname === 'oauth2.googleapis.com' ? GOOGLE : APPLE;
  const body = await request.formData();
  const code = body.get('code') ?? '';

  // Apple authenticates with a signed JWT rather than a static secret;
  // assert it at least looks like one, so a broken key is caught here.
  if (provider === APPLE) {
    const secret = body.get('client_secret') ?? '';
    if (secret.split('.').length !== 3) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
  }

  if (code.includes('denied')) return Response.json({ error: 'invalid_grant' }, { status: 400 });

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: code.includes('wrong-issuer') ? 'https://evil.example' : provider.issuer,
    aud: code.includes('wrong-audience') ? 'some-other-app' : provider.audience,
    sub: code.includes('no-subject') ? undefined : provider.subject,
    email: code.includes('no-email') ? undefined : provider.email,
    // Both providers send this; Apple as a string. `ALLOWED_EMAILS` is
    // weighed against it, so the stand-in has to carry it too.
    email_verified: code.includes('unverified-email') ? false : true,
    exp: code.includes('expired') ? now - 60 : now + 600,
  };

  return Response.json({
    access_token: 'upstream-access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    ...(code.includes('no-id-token') ? {} : { id_token: idToken(claims) }),
  });
}

// ---------------------------------------------------------------------------
// intervals.icu
// ---------------------------------------------------------------------------

/** The key a test uses to mean "this one is no longer valid". */
const REVOKED_KEY = 'revoked-key';

const freshState = () => ({
  athlete: { id: 'i99999', name: 'Test Athlete' },
  /** Calendar events by their numeric id. */
  events: new Map(),
  /** Our upsert key -> the event id it landed on. */
  byUid: new Map(),
  /** Recorded activities, as `completions` reads them. */
  activities: [],
  nextId: 7000,
  /** Path fragment -> status, to make one endpoint fail on demand. */
  failing: {},
  /** Every intervals.icu request seen, so a test can assert the call was made. */
  requests: [],
});

let state = freshState();

const asEvent = ([id, event]) => ({ id: Number(id), ...event });

/** The key out of `Basic base64("API_KEY:<key>")`, or null if it is not one. */
function credential(request) {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = atob(header.slice('Basic '.length));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 0 || decoded.slice(0, separator) !== 'API_KEY') return null;
  return decoded.slice(separator + 1);
}

function control(request, path) {
  if (path === '/__control/reset') {
    state = freshState();
    return Response.json({ ok: true });
  }
  if (path === '/__control/state') {
    return Response.json({
      events: [...state.events.entries()].map(asEvent),
      requests: state.requests,
    });
  }
  if (path === '/__control/setup') {
    // `{ activities?, failing?, athlete? }` — whatever a test needs to arrange.
    return request.json().then((body) => {
      if (body.activities) state.activities = body.activities;
      if (body.failing) state.failing = body.failing;
      if (body.athlete) state.athlete = body.athlete;
      return Response.json({ ok: true });
    });
  }
  return new Response('no such control endpoint', { status: 404 });
}

async function intervals(request, url) {
  const path = url.pathname;
  if (path.startsWith('/__control/')) return control(request, path);

  state.requests.push({ method: request.method, path, search: url.search });

  // Drained here rather than where it is wanted: a request answered without
  // its body being read — the 401 and the arranged failures below — leaves
  // workerd complaining about the stream once the response has gone out.
  const payload = request.method === 'GET' || request.method === 'HEAD' ? null : await request.text();

  const key = credential(request);
  if (!key || key === REVOKED_KEY) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  for (const [fragment, status] of Object.entries(state.failing)) {
    if (path.includes(fragment)) return new Response(`intervals is unhappy about ${fragment}`, { status });
  }

  // GET /api/v1/athlete/0
  if (request.method === 'GET' && /^\/api\/v1\/athlete\/[^/]+$/.test(path)) {
    return Response.json(state.athlete);
  }

  // GET /api/v1/athlete/0/activities
  if (request.method === 'GET' && path.endsWith('/activities')) {
    const oldest = url.searchParams.get('oldest');
    const newest = url.searchParams.get('newest');
    const within = (activity) => {
      const day = (activity.start_date_local ?? activity.start_date ?? '').slice(0, 10);
      return (!oldest || day >= oldest) && (!newest || day <= newest);
    };
    return Response.json(state.activities.filter(within));
  }

  // POST /api/v1/athlete/0/events?upsertOnUid=true
  if (request.method === 'POST' && path.endsWith('/events')) {
    const body = JSON.parse(payload);
    if (!body.file_contents_base64) return new Response('no workout in the event', { status: 400 });

    const upsert = url.searchParams.get('upsertOnUid') === 'true';
    const existing = upsert && body.uid ? state.byUid.get(body.uid) : undefined;
    const id = existing ?? state.nextId++;
    state.events.set(id, { ...body });
    if (body.uid) state.byUid.set(body.uid, id);
    return Response.json({ id, ...body });
  }

  // DELETE /api/v1/athlete/0/events/{id}
  const deletion = /^\/api\/v1\/athlete\/[^/]+\/events\/(\d+)$/.exec(path);
  if (request.method === 'DELETE' && deletion) {
    const id = Number(deletion[1]);
    const event = state.events.get(id);
    if (!event) return new Response('no such event', { status: 404 });
    state.events.delete(id);
    if (event.uid) state.byUid.delete(event.uid);
    return Response.json({ deleted: true });
  }

  return new Response(`unexpected intervals.icu request: ${request.method} ${path}`, { status: 404 });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === 'intervals.icu') return intervals(request, url);
    if (url.hostname === 'oauth2.googleapis.com' || url.hostname === 'appleid.apple.com') {
      return signIn(request, url);
    }
    return new Response(`unexpected outbound request to ${url.host}`, { status: 502 });
  },
};
