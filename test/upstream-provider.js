/**
 * A stand-in for every third party this app talks to, run as an auxiliary
 * Worker that Miniflare routes all outbound traffic to. The Worker under test
 * therefore runs its real code paths — Apple's ES256 client-secret JWT, the
 * Garmin PKCE exchange, the Training API calls — without touching the network.
 *
 * It is also bound into the tests as `GARMIN_STUB`, so a test can ask what
 * Garmin was actually sent rather than inferring it from the sync report.
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

// ---------------------------------------------------------------------------
// Sign-in providers
// ---------------------------------------------------------------------------

async function signInProvider(request, provider) {
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
// Garmin
// ---------------------------------------------------------------------------

/**
 * Everything Garmin is pretending to remember, plus the knobs a test turns.
 *
 * Module scope, which survives between requests inside the isolate — the same
 * reason it has a `/reset` rather than being rebuilt per call.
 */
const garmin = {
  /** garminWorkoutId -> the payload last accepted for it. */
  workouts: new Map(),
  /** garminScheduleId -> { workoutId, date }. */
  schedules: new Map(),
  /** Every call made, in order, for a test to assert against. */
  calls: [],
  nextId: 9000,
  /** Access tokens the token endpoint has handed out, newest last. */
  issued: [],
  /** Activities the athlete has recorded, as the Activity API would report them. */
  activities: [],
  /**
   * Test knobs:
   *  rejectNamed     — refuse any workout whose name contains this
   *  expireTokens    — answer every Training API call with 401 until refreshed
   *  failSchedule    — refuse the next schedule call
   *  refuseRefresh   — refuse the refresh grant
   *  refuseActivities — answer the activity query with a 403
   */
  fail: {},
};

function resetGarmin() {
  garmin.workouts.clear();
  garmin.schedules.clear();
  garmin.calls = [];
  garmin.nextId = 9000;
  garmin.issued = [];
  garmin.activities = [];
  garmin.fail = {};
}

const garminState = () => ({
  workouts: [...garmin.workouts.entries()].map(([id, payload]) => ({ id, payload })),
  schedules: [...garmin.schedules.entries()].map(([id, entry]) => ({ id, ...entry })),
  calls: garmin.calls,
  issued: garmin.issued,
});

/** The OAuth2 PKCE token endpoint. */
async function garminToken(request) {
  const body = await request.formData();
  const grant = body.get('grant_type');
  garmin.calls.push({ what: 'token', grant });

  if (!body.get('client_id') || !body.get('client_secret')) {
    return Response.json({ error: 'invalid_client' }, { status: 401 });
  }

  if (grant === 'authorization_code') {
    // PKCE: the exchange is only meaningful if the verifier came with it.
    if (!body.get('code_verifier')) {
      return Response.json({ error: 'invalid_request', error_description: 'code_verifier missing' }, { status: 400 });
    }
    if (String(body.get('code')).includes('denied')) {
      return Response.json({ error: 'invalid_grant', error_description: 'the code was rejected' }, { status: 400 });
    }
  } else if (grant === 'refresh_token') {
    if (garmin.fail.refuseRefresh) {
      return Response.json({ error: 'invalid_grant', error_description: 'refresh token revoked' }, { status: 400 });
    }
    // A refresh clears an expiry the test had forced, which is what makes the
    // refresh-then-retry path observable.
    garmin.fail.expireTokens = false;
  } else {
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }

  const token = `garmin-access-${garmin.issued.length + 1}`;
  garmin.issued.push(token);
  return Response.json({
    access_token: token,
    token_type: 'Bearer',
    expires_in: garmin.fail.shortLived ? 1 : 86400,
    refresh_token: `garmin-refresh-${garmin.issued.length}`,
    refresh_token_expires_in: 7776000,
  });
}

const unauthorized = () => Response.json({ error: 'unauthorized' }, { status: 401 });

async function garminApi(request, url) {
  const path = url.pathname;
  const bearer = (request.headers.get('Authorization') ?? '').replace('Bearer ', '');

  if (path === '/wellness-api/rest/user/id') return Response.json({ userId: 'garmin-athlete-1' });

  // What the athlete recorded. Sliced by upload time, as Garmin slices it, so
  // the Worker's day-at-a-time querying is exercised rather than assumed.
  if (path === '/activity-api/rest/activities') {
    garmin.calls.push({ what: 'GET /activity-api/rest/activities' });
    if (!bearer || garmin.fail.expireTokens) return unauthorized();
    if (garmin.fail.refuseActivities) return Response.json({ errorMessage: 'no' }, { status: 403 });

    const from = Number(url.searchParams.get('uploadStartTimeInSeconds'));
    const to = Number(url.searchParams.get('uploadEndTimeInSeconds'));
    return Response.json(
      garmin.activities.filter((activity) => {
        const uploaded = activity.uploadTimeInSeconds ?? activity.startTimeInSeconds;
        return uploaded > from && uploaded <= to;
      }),
    );
  }
  if (path === '/wellness-api/rest/user/registration') {
    garmin.calls.push({ what: 'deregister' });
    return new Response(null, { status: 204 });
  }

  if (!path.startsWith('/training-api/')) {
    return new Response(`unexpected garmin path ${path}`, { status: 404 });
  }
  if (!bearer) return unauthorized();
  if (garmin.fail.expireTokens) return unauthorized();

  const body = request.method === 'POST' || request.method === 'PUT' ? await request.json() : null;
  garmin.calls.push({ what: `${request.method} ${path}`, body });

  // Workouts
  if (path === '/training-api/workout' && request.method === 'POST') {
    if (garmin.fail.rejectNamed && String(body?.workoutName ?? '').includes(garmin.fail.rejectNamed)) {
      return Response.json({ errorMessage: 'unsupported step configuration' }, { status: 400 });
    }
    const id = String(garmin.nextId++);
    garmin.workouts.set(id, body);
    return Response.json({ workoutId: Number(id) });
  }

  const workout = path.match(/^\/training-api\/workout\/(\d+)$/);
  if (workout) {
    if (!garmin.workouts.has(workout[1])) return Response.json({ errorMessage: 'no such workout' }, { status: 404 });
    if (request.method === 'PUT') {
      if (garmin.fail.rejectNamed && String(body?.workoutName ?? '').includes(garmin.fail.rejectNamed)) {
        return Response.json({ errorMessage: 'unsupported step configuration' }, { status: 400 });
      }
      garmin.workouts.set(workout[1], body);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'DELETE') {
      garmin.workouts.delete(workout[1]);
      return new Response(null, { status: 204 });
    }
  }

  // The calendar
  if (path === '/training-api/schedule' && request.method === 'POST') {
    if (garmin.fail.failSchedule) {
      garmin.fail.failSchedule = false;
      return Response.json({ errorMessage: 'calendar unavailable' }, { status: 500 });
    }
    if (!garmin.workouts.has(String(body?.workoutId))) {
      return Response.json({ errorMessage: 'no such workout' }, { status: 400 });
    }
    const id = String(garmin.nextId++);
    garmin.schedules.set(id, { workoutId: String(body.workoutId), date: body.date });
    return Response.json({ workoutScheduleId: Number(id) });
  }

  const schedule = path.match(/^\/training-api\/schedule\/(\d+)$/);
  if (schedule && request.method === 'DELETE') {
    if (!garmin.schedules.has(schedule[1])) return Response.json({ errorMessage: 'gone' }, { status: 404 });
    garmin.schedules.delete(schedule[1]);
    return new Response(null, { status: 204 });
  }

  return new Response(`unexpected garmin call ${request.method} ${path}`, { status: 405 });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // The tests' own control surface, reached over the service binding rather
    // than by the Worker under test.
    if (url.pathname === '/__stub/reset') {
      resetGarmin();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__stub/state') return Response.json(garminState());
    if (url.pathname === '/__stub/fail') {
      Object.assign(garmin.fail, await request.json());
      return Response.json({ ok: true });
    }
    // Stands in for the athlete deleting a synced workout in the Connect app:
    // the workout and its calendar entries go, and our stored ids go stale.
    // Seeds what the athlete recorded, for the completion pull to find.
    if (url.pathname === '/__stub/activities') {
      garmin.activities = await request.json();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/__stub/forget') {
      for (const id of garmin.workouts.keys()) {
        garmin.workouts.delete(id);
        for (const [scheduleId, entry] of garmin.schedules) {
          if (entry.workoutId === id) garmin.schedules.delete(scheduleId);
        }
      }
      return Response.json({ ok: true });
    }

    if (url.hostname === 'oauth2.googleapis.com') return signInProvider(request, GOOGLE);
    if (url.hostname === 'appleid.apple.com') return signInProvider(request, APPLE);
    if (url.hostname === 'diauth.garmin.com') return garminToken(request);
    if (url.hostname === 'apis.garmin.com') return garminApi(request, url);

    return new Response(`unexpected outbound request to ${url.host}`, { status: 502 });
  },
};
