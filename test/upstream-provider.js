/**
 * A stand-in for Google's and Apple's token endpoints, run as an auxiliary
 * Worker that Miniflare routes all outbound traffic to. The Worker under test
 * therefore runs the real `arctic` code path — Apple's ES256 client-secret JWT
 * included — without touching the network.
 *
 * The response is chosen by the `code` the test hands to the callback, so no
 * shared state is needed between the two isolates.
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

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const provider = url.hostname === 'oauth2.googleapis.com' ? GOOGLE : url.hostname === 'appleid.apple.com' ? APPLE : null;
    if (!provider) return new Response(`unexpected outbound request to ${url.host}`, { status: 502 });

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
  },
};
