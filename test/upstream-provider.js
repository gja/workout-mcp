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
 *
 *   - Google Drive, which needs state for the same reason: a test copies a race
 *     and then asks what path it landed at. The service account's own token
 *     exchange is the `jwt-bearer` grant on the same Google host as sign-in.
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

  // The service account's token exchange shares this endpoint with sign-in.
  if (body.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
    return serviceAccountToken(body.get('assertion') ?? '');
  }

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
// Google Drive
// ---------------------------------------------------------------------------

/** The one shared drive the service account is a member of. */
const SHARED_DRIVE = 'shared-drive-1';

const FOLDER_TYPE = 'application/vnd.google-apps.folder';

const ACCESS_TOKEN = 'drive-access-token';

/**
 * Check the assertion the Worker signed itself.
 *
 * The signature is not verified — the stand-in has no public key — but the
 * claims are, which is what catches a wrong audience, a missing scope or a key
 * that failed to import before the request was ever built.
 */
function serviceAccountToken(assertion) {
  const segments = assertion.split('.');
  if (segments.length !== 3) {
    return Response.json({ error: 'invalid_grant', error_description: 'not a JWT' }, { status: 400 });
  }

  let claims;
  try {
    claims = JSON.parse(atob(segments[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return Response.json({ error: 'invalid_grant', error_description: 'unreadable claims' }, { status: 400 });
  }

  if (claims.aud !== 'https://oauth2.googleapis.com/token' || !claims.iss || !claims.scope) {
    return Response.json({ error: 'invalid_grant', error_description: 'bad claims' }, { status: 400 });
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return Response.json({ error: 'invalid_grant', error_description: 'expired assertion' }, { status: 400 });
  }
  return Response.json({ access_token: ACCESS_TOKEN, token_type: 'Bearer', expires_in: 3600 });
}

/** The bytes of one uploaded part, out of a `multipart/related` body. */
function readMultipart(bytes, boundary) {
  const characters = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('');
  const parts = characters.split(`--${boundary}`).slice(1, -1);
  const bodyOf = (part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
  return { metadata: JSON.parse(bodyOf(parts[0])), content: bodyOf(parts[1] ?? '\r\n\r\n') };
}

/** `workouts-mcp/intervals.icu/2026-09/…`, walked back up through the parents. */
function drivePath(id) {
  const segments = [];
  for (let at = id; at && at !== SHARED_DRIVE; at = state.drive.files.get(at)?.parents?.[0]) {
    const file = state.drive.files.get(at);
    if (!file) break;
    segments.unshift(file.name);
  }
  return segments.join('/');
}

/** Drive's `q` is `name = 'x' and 'parent' in parents and …`; the quoted values in order. */
const quoted = (query) => [...query.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1].replace(/\\(.)/g, '$1'));

function drive(request, url) {
  const path = url.pathname;
  if (request.headers.get('Authorization') !== `Bearer ${ACCESS_TOKEN}`) {
    return Response.json({ error: { message: 'Invalid Credentials' } }, { status: 401 });
  }
  state.drive.requests.push({ method: request.method, path, search: url.search });

  for (const [fragment, status] of Object.entries(state.drive.failing)) {
    if (path.includes(fragment)) {
      return Response.json({ error: { message: `Drive is unhappy about ${fragment}` } }, { status });
    }
  }

  // GET /drive/v3/drives/{id}
  const asDrive = /^\/drive\/v3\/drives\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && asDrive) {
    return asDrive[1] === SHARED_DRIVE
      ? Response.json({ id: SHARED_DRIVE, name: 'Race Files' })
      : Response.json({ error: { message: 'File not found' } }, { status: 404 });
  }

  // GET /drive/v3/files/{id}
  const asFile = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
  if (request.method === 'GET' && asFile) {
    const found = state.drive.files.get(asFile[1]);
    return found
      ? Response.json({ id: asFile[1], name: found.name, mimeType: found.mimeType })
      : Response.json({ error: { message: 'File not found' } }, { status: 404 });
  }

  // GET /drive/v3/files?q=…
  if (request.method === 'GET' && path === '/drive/v3/files') {
    const [name, parent, mimeType] = quoted(url.searchParams.get('q') ?? '');
    const files = [...state.drive.files.entries()]
      .filter(([, file]) => file.name === name && file.parents?.[0] === parent && file.mimeType === mimeType)
      .map(([id]) => ({ id }));
    return Response.json({ files });
  }

  // POST /drive/v3/files — a folder, with no bytes
  if (request.method === 'POST' && path === '/drive/v3/files') {
    return request.json().then((body) => {
      const id = `file-${state.drive.nextId++}`;
      state.drive.files.set(id, { name: body.name, mimeType: body.mimeType, parents: body.parents });
      return Response.json({ id });
    });
  }

  // POST /upload/drive/v3/files?uploadType=multipart
  if (request.method === 'POST' && path === '/upload/drive/v3/files') {
    const boundary = /boundary=([^;]+)/.exec(request.headers.get('Content-Type') ?? '')?.[1];
    if (!boundary) return Response.json({ error: { message: 'no boundary' } }, { status: 400 });

    return request.arrayBuffer().then((buffer) => {
      const { metadata, content } = readMultipart(new Uint8Array(buffer), boundary);
      const id = `file-${state.drive.nextId++}`;
      state.drive.files.set(id, {
        name: metadata.name,
        mimeType: 'application/vnd.ant.fit',
        parents: metadata.parents,
        content,
      });
      return Response.json({ id });
    });
  }

  return new Response(`unexpected Google Drive request: ${request.method} ${path}`, { status: 404 });
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
  /** Google Drive: the files put there, the calls that put them, and arranged failures.
   *  Seeded with a folder in someone's own Drive, which is a thing a link can name
   *  and this integration has to refuse. */
  drive: {
    files: new Map([['personal-folder-1', { name: 'Races', mimeType: FOLDER_TYPE, parents: ['root'] }]]),
    nextId: 1,
    requests: [],
    failing: {},
  },
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
  if (path === '/__control/drive') {
    return Response.json({
      files: [...state.drive.files.entries()]
        .filter(([, file]) => file.mimeType !== FOLDER_TYPE)
        .map(([id, file]) => ({ id, path: drivePath(id), content: file.content })),
      folders: [...state.drive.files.values()].filter((file) => file.mimeType === FOLDER_TYPE).map((f) => f.name),
      requests: state.drive.requests,
    });
  }
  if (path === '/__control/setup') {
    // `{ activities?, failing?, athlete? }` — whatever a test needs to arrange.
    return request.json().then((body) => {
      if (body.activities) state.activities = body.activities;
      if (body.failing) state.failing = body.failing;
      if (body.driveFailing) state.drive.failing = body.driveFailing;
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

  // GET /api/v1/activity/{id}/file, and the FIT intervals.icu builds itself
  const recording = /^\/api\/v1\/activity\/([^/]+)\/(file|fit-file)$/.exec(path);
  if (request.method === 'GET' && recording) {
    // Stands in for FIT bytes, and names which of the two endpoints answered.
    const body = `${recording[2]}:${recording[1]}`;
    return new Response(body, {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(body.length) },
    });
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
    if (url.hostname === 'www.googleapis.com') return drive(request, url);
    if (url.hostname === 'oauth2.googleapis.com' || url.hostname === 'appleid.apple.com') {
      return signIn(request, url);
    }
    return new Response(`unexpected outbound request to ${url.host}`, { status: 502 });
  },
};
