import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { isAllowed } from '../src/auth';
import { cookieFrom, resetDatabase, sessionCookieFor, signIn } from './helpers';

const BASE = 'https://workouts.example';

beforeEach(resetDatabase);

/** Start a sign-in and hand back the state plus the cookie that goes with it. */
async function startLogin(query = ''): Promise<{ state: string; cookie: string }> {
  const started = await SELF.fetch(`${BASE}/auth/google/start${query}`, { redirect: 'manual' });
  return {
    state: new URL(started.headers.get('Location')!).searchParams.get('state')!,
    cookie: cookieFrom(started, 'workout_login'),
  };
}

/** The session cookie a response set, or '' — a failed sign-in sets none. */
const sessionFrom = (response: Response) => cookieFrom(response, 'workout_session');

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe('providers', () => {
  it('advertises the ones this deployment has configured', async () => {
    const response = await SELF.fetch(`${BASE}/auth/providers`);
    expect(await response.json()).toEqual({ providers: ['google', 'apple'] });
  });

  it('rejects a provider it does not know', async () => {
    expect((await SELF.fetch(`${BASE}/auth/facebook/start`, { redirect: 'manual' })).status).toBe(404);
  });
});

describe('starting a sign-in', () => {
  it('redirects to Google with PKCE and a remembered state', async () => {
    const response = await SELF.fetch(`${BASE}/auth/google/start`, { redirect: 'manual' });
    expect(response.status).toBe(302);

    const target = new URL(response.headers.get('Location')!);
    expect(target.host).toBe('accounts.google.com');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('scope')).toContain('email');
    expect(target.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/google/callback`);

    const stored = await env.DB.prepare('SELECT provider, code_verifier FROM login_states WHERE state = ?')
      .bind(target.searchParams.get('state'))
      .first<{ provider: string; code_verifier: string | null }>();
    expect(stored).toMatchObject({ provider: 'google' });
    expect(stored?.code_verifier).toBeTruthy();
  });

  it('asks Apple to post the callback back, as Apple requires with a scope', async () => {
    const response = await SELF.fetch(`${BASE}/auth/apple/start`, { redirect: 'manual' });
    const target = new URL(response.headers.get('Location')!);
    expect(target.host).toBe('appleid.apple.com');
    expect(target.searchParams.get('response_mode')).toBe('form_post');
    expect(target.searchParams.get('scope')).toBe('email');
  });
});

describe('finishing a sign-in', () => {
  it('creates the account and sets a session', async () => {
    const response = await signIn('google');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(`${BASE}/`);
    expect(response.headers.getSetCookie().join(' ')).toContain('HttpOnly');

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionFrom(response) } });
    expect(await me.json()).toMatchObject({ email: 'athlete@example.com' });
  });

  it('accepts Apple posting the callback as a form', async () => {
    const response = await signIn('apple');
    expect(response.status).toBe(303);

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionFrom(response) } });
    // Apple hands out a private relay address, and that is fine.
    expect(await me.json()).toMatchObject({ email: 'athlete@privaterelay.appleid.com' });
  });

  it('reuses the account on a second sign-in with the same provider', async () => {
    await signIn('google');
    await signIn('google');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(1);
  });

  it('keeps Google and Apple as separate accounts', async () => {
    await signIn('google');
    await signIn('apple');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(2);
  });

  it('consumes the state, so a callback cannot be replayed', async () => {
    const { state, cookie } = await startLogin();
    const callback = () =>
      SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${state}`, {
        headers: { Cookie: cookie },
        redirect: 'manual',
      });

    expect(sessionFrom(await callback())).toBeTruthy();
    const replay = await callback();
    expect(sessionFrom(replay)).toBe('');
    expect(replay.headers.get('Location')).toContain('error=');
  });

  it('refuses a callback for a sign-in this browser did not start', async () => {
    // The attacker starts a sign-in of their own and walks the victim through
    // its callback. Without the cookie the victim's browser would come out of
    // it holding a session for the attacker's account.
    const { state } = await startLogin();

    const forged = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${state}`, { redirect: 'manual' });
    expect(sessionFrom(forged)).toBe('');
    expect(forged.headers.get('Location')).toContain('error=');
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
  });

  it('refuses a callback carrying some other sign-in\'s cookie', async () => {
    const mine = await startLogin();
    const theirs = await startLogin();

    const crossed = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${theirs.state}`, {
      headers: { Cookie: mine.cookie },
      redirect: 'manual',
    });
    expect(sessionFrom(crossed)).toBe('');
    expect(crossed.headers.get('Location')).toContain('error=');
  });

  it('refuses an unknown or expired state', async () => {
    const unknown = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=made-up`, { redirect: 'manual' });
    expect(unknown.headers.get('Location')).toContain('error=');

    const { state, cookie } = await startLogin();
    await env.DB.prepare('UPDATE login_states SET expires_at = ? WHERE state = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), state)
      .run();

    const expired = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${state}`, {
      headers: { Cookie: cookie },
      redirect: 'manual',
    });
    expect(sessionFrom(expired)).toBe('');
  });

  it('will not accept a state issued for the other provider', async () => {
    const { state, cookie } = await startLogin();

    const crossed = await SELF.fetch(`${BASE}/auth/apple/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
      body: new URLSearchParams({ code: 'ok', state }).toString(),
      redirect: 'manual',
    });
    expect(sessionFrom(crossed)).toBe('');
  });

  it('rejects an ID token that fails its checks', async () => {
    for (const code of ['wrong-issuer', 'wrong-audience', 'expired', 'no-subject', 'no-id-token']) {
      const response = await signIn('google', code);
      expect(sessionFrom(response), code).toBe('');
      expect(response.headers.get('Location'), code).toContain('error=');
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
  });

  it('reports a refusal from the provider', async () => {
    const response = await signIn('google', 'denied');
    expect(sessionFrom(response)).toBe('');
  });

  it('passes a cancelled sign-in back to the dashboard', async () => {
    const response = await SELF.fetch(`${BASE}/auth/google/callback?error=access_denied&state=x`, {
      redirect: 'manual',
    });
    expect(response.headers.get('Location')).toContain('error=');
  });

  it('returns to where the sign-in started, but only within this site', async () => {
    const inside = await startLogin(`?return_to=${encodeURIComponent('/oauth/authorize?x=1')}`);
    const done = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${inside.state}`, {
      headers: { Cookie: inside.cookie },
      redirect: 'manual',
    });
    expect(done.headers.get('Location')).toBe(`${BASE}/oauth/authorize?x=1`);

    // An absolute URL elsewhere is dropped rather than followed.
    const evil = await startLogin(`?return_to=${encodeURIComponent('https://evil.example')}`);
    const landed = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${evil.state}`, {
      headers: { Cookie: evil.cookie },
      redirect: 'manual',
    });
    expect(landed.headers.get('Location')).toBe(`${BASE}/`);
  });
});

describe('the allowlist', () => {
  it('matches by address or domain, and is open when unset', () => {
    expect(isAllowed({} as never, 'anyone@example.com')).toBe(true);
    const gated = { ALLOWED_EMAILS: 'me@example.com, @team.example' } as never;
    expect(isAllowed(gated, 'me@example.com')).toBe(true);
    expect(isAllowed(gated, 'someone@team.example')).toBe(true);
    expect(isAllowed(gated, 'stranger@example.com')).toBe(false);
    // A provider that hands back no address cannot be matched against a list.
    expect(isAllowed(gated, null)).toBe(false);
  });
});

describe('sessions', () => {
  it('signs out', async () => {
    const cookie = await sessionCookieFor();
    const out = await post('/api/auth/logout', {}, { Cookie: cookie });
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('ignores a made-up session cookie', async () => {
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: 'workout_session=deadbeef' } })).status).toBe(401);
  });
});

describe('API tokens', () => {
  it('issues a token that then works as a bearer credential', async () => {
    const cookie = await sessionCookieFor();
    const created = await post('/api/tokens', { name: 'Garmin watch' }, { Cookie: cookie });
    expect(created.status).toBe(201);

    const { token, prefix } = (await created.json()) as { token: string; prefix: string };
    expect(token).toMatch(/^wk_[0-9a-f]{64}$/);
    expect(prefix).toBe(token.slice(0, 9));

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ email: 'athlete@example.com' });
  });

  it('lists tokens by prefix only, never the secret', async () => {
    const cookie = await sessionCookieFor();
    const { token } = (await (await post('/api/tokens', { name: 'Watch' }, { Cookie: cookie })).json()) as {
      token: string;
    };

    const listed = (await (await SELF.fetch(`${BASE}/api/tokens`, { headers: { Cookie: cookie } })).json()) as {
      tokens: { prefix: string; name: string }[];
    };
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]).toMatchObject({ name: 'Watch', prefix: token.slice(0, 9) });
    expect(JSON.stringify(listed)).not.toContain(token);
  });

  it('revokes a token', async () => {
    const cookie = await sessionCookieFor();
    const { token, prefix } = (await (await post('/api/tokens', {}, { Cookie: cookie })).json()) as {
      token: string;
      prefix: string;
    };

    expect((await SELF.fetch(`${BASE}/api/tokens/${prefix}`, { method: 'DELETE', headers: { Cookie: cookie } })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('needs a credential to mint more tokens', async () => {
    expect((await post('/api/tokens', {})).status).toBe(401);
  });
});
