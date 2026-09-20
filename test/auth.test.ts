import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { secretsMatch } from '../src/auth';
import { today } from '../src/units';
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
    expect(await response.json()).toEqual({ providers: ['google', 'apple', 'intervals'], native: ['apple'] });
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

describe('linking a second provider', () => {
  const accounts = async () =>
    (await env.DB.prepare('SELECT COUNT(*) AS count FROM users WHERE alias_of_user_id IS NULL').first<{
      count: number;
    }>())?.count;

  it('is one account when the address matches and both providers vouch for it', async () => {
    const google = await signIn('google');
    const apple = await signIn('apple', 'ok-shared-email');

    expect(await accounts()).toBe(1);

    // The same account, reached two ways: what the first one wrote is there for the second.
    const created = await SELF.fetch(`${BASE}/api/workouts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: sessionFrom(google) },
      body: JSON.stringify({ date: today(), name: 'Easy hour', steps: [{ name: 'Easy', goal_s: 3600 }] }),
    });
    expect(created.status).toBe(201);

    const listed = await SELF.fetch(`${BASE}/api/workouts.json`, { headers: { Cookie: sessionFrom(apple) } });
    expect((await listed.json()) as { workouts: unknown[] }).toMatchObject({ workouts: [{ name: 'Easy hour' }] });
  });

  // The account's own provider finds the row linked to it, which is not a link back.
  it('stays one account when the first provider signs in again', async () => {
    await signIn('google');
    await signIn('apple', 'ok-shared-email');
    const again = await signIn('google');

    expect(await accounts()).toBe(1);
    const primary = await env.DB.prepare(
      "SELECT id FROM users WHERE provider = 'google' AND alias_of_user_id IS NULL",
    ).first<{ id: string }>();

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionFrom(again) } });
    expect(await me.json()).toMatchObject({ id: primary?.id });
  });

  // The state 0015 leaves an athlete who already had two: whichever signs in first would
  // be the one demoted, and its workouts are under the row that stops being an account.
  it('leaves two accounts already made alone, whichever signs in again', async () => {
    const google = await signIn('google');
    await env.DB.prepare(
      `INSERT INTO users (id, provider, subject, email, email_verified, created_at, last_login_at)
       VALUES ('made-before', 'apple', 'apple-user-1', 'athlete@example.com', 1, '2026-01-01T00:00:00.000Z', NULL)`,
    ).run();

    await signIn('google');
    await signIn('apple', 'ok-shared-email');
    expect(await accounts()).toBe(2);

    // And the older one still answers for itself rather than for the other.
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionFrom(google) } });
    expect(await me.json()).toMatchObject({ email: 'athlete@example.com' });
    const apple = await env.DB.prepare("SELECT id FROM users WHERE provider = 'apple'").first<{ id: string }>();
    expect(apple?.id).toBe('made-before');
  });

  // An MCP client connected under the row that was linked reads the account, not the row
  // it was approved against — otherwise the plan goes empty the day the link is made.
  it('follows the link for a token issued before it', async () => {
    const apple = await signIn('apple');
    const { token } = (await (
      await SELF.fetch(`${BASE}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionFrom(apple) },
        body: JSON.stringify({ name: 'Claude' }),
      })
    ).json()) as { token: string };

    const google = await env.DB.prepare("SELECT id FROM users WHERE provider = 'apple'").first<{ id: string }>();
    await env.DB.prepare(
      `INSERT INTO users (id, provider, subject, email, email_verified, created_at)
       VALUES ('the-account', 'google', 'g-1', 'athlete@example.com', 1, '2026-01-01T00:00:00.000Z')`,
    ).run();
    await env.DB.prepare("UPDATE users SET alias_of_user_id = 'the-account' WHERE id = ?").bind(google?.id).run();

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ id: 'the-account' });
  });

  // A credential nobody can see is a credential nobody can revoke, and the app's was
  // issued under the row that a link by hand demotes. See docs/auth.md.
  it('shows and revokes a token issued under the linked row', async () => {
    const google = await signIn('google');
    const apple = await signIn('apple');
    const { token, prefix } = (await (
      await SELF.fetch(`${BASE}/api/tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionFrom(apple) },
        body: JSON.stringify({ name: 'WorkoutsMCP for iOS' }),
      })
    ).json()) as { token: string; prefix: string };

    const account = (await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionFrom(google) } }).then((r) =>
      r.json(),
    )) as { id: string };
    await env.DB.prepare("UPDATE users SET alias_of_user_id = ? WHERE provider = 'apple'").bind(account.id).run();
    const asAccount = { Cookie: sessionFrom(google) };

    const listed = await SELF.fetch(`${BASE}/api/tokens`, { headers: asAccount });
    expect(await listed.json()).toMatchObject({ tokens: [{ name: 'WorkoutsMCP for iOS' }] });

    const revoked = await SELF.fetch(`${BASE}/api/tokens/${prefix}`, { method: 'DELETE', headers: asAccount });
    expect(revoked.status).toBe(200);

    const after = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(after.status).toBe(401);
  });

  it('is two accounts when the addresses differ', async () => {
    await signIn('google');
    await signIn('apple');
    expect(await accounts()).toBe(2);
  });

  // The address is the whole proof, so a provider that will not vouch for it proves nothing.
  it('will not link on an address nobody vouched for', async () => {
    await signIn('google');
    await signIn('apple', 'ok-shared-email-unverified-email');
    expect(await accounts()).toBe(2);
  });

  it('leaves the account deleted by hand behind, and links what is left', async () => {
    await signIn('google');
    await signIn('apple', 'ok-shared-email');
    await env.DB.prepare("DELETE FROM users WHERE provider = 'google'").run();

    // Signing in again makes a row, which finds the Apple account rather than standing alone.
    const again = await signIn('google');
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: sessionFrom(again) } });
    const { id } = (await me.json()) as { id: string };

    const apple = await env.DB.prepare("SELECT id FROM users WHERE provider = 'apple'").first<{ id: string }>();
    expect(id).toBe(apple?.id);
  });
});

describe('the native Sign in with Apple', () => {
  const nativeSignIn = (body: unknown) => post('/api/apple-session', body);

  it('mints an API token from the code the app was handed', async () => {
    const response = await nativeSignIn({ code: 'ok', name: 'WorkoutsMCP for iOS' });
    expect(response.status, await response.clone().text()).toBe(200);

    const { token } = (await response.json()) as { token: string };
    expect(token).toMatch(/^wk_/);

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ email: 'athlete@privaterelay.appleid.com' });
  });

  // The whole reason the native flow can be added at all: Apple scopes the subject to the
  // team, so the app and the browser are the same athlete rather than two accounts.
  it('lands on the account the browser sign-in makes', async () => {
    await signIn('apple');
    await nativeSignIn({ code: 'ok' });

    const users = await env.DB.prepare("SELECT COUNT(*) AS count FROM users WHERE provider = 'apple'").first<{
      count: number;
    }>();
    expect(users?.count).toBe(1);
  });

  it('is revocable like any other token', async () => {
    const { token } = (await (await nativeSignIn({ code: 'ok' })).json()) as { token: string };
    const listed = await SELF.fetch(`${BASE}/api/tokens`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await listed.json()).toMatchObject({ tokens: [{ name: 'A native app' }] });
  });

  // Apple sends the address through the browser and may leave it out of a native sign-in.
  it('keeps the address a browser sign-in already learned', async () => {
    await signIn('apple');
    const { token } = (await (await nativeSignIn({ code: 'ok-no-email' })).json()) as { token: string };

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ email: 'athlete@privaterelay.appleid.com' });
  });

  it('refuses a code Apple will not spend, and one that is missing', async () => {
    expect((await nativeSignIn({ code: 'denied' })).status).toBe(401);
    expect((await nativeSignIn({})).status).toBe(400);
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

    // And some other sign-in's cookie is not this sign-in's either.
    const mine = await startLogin();
    const theirs = await startLogin();
    const crossed = await SELF.fetch(`${BASE}/auth/google/callback?code=ok&state=${theirs.state}`, {
      headers: { Cookie: mine.cookie },
      redirect: 'manual',
    });
    expect(sessionFrom(crossed)).toBe('');
    expect(crossed.headers.get('Location')).toContain('error=');

    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0);
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

  it('passes a refused or cancelled sign-in back to the dashboard', async () => {
    const refused = await signIn('google', 'denied');
    expect(sessionFrom(refused)).toBe('');

    const cancelled = await SELF.fetch(`${BASE}/auth/google/callback?error=access_denied&state=x`, {
      redirect: 'manual',
    });
    expect(cancelled.headers.get('Location')).toContain('error=');
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

describe('signing in with intervals.icu', () => {
  /** Drive the round and hand back the callback's response. */
  const signInWithIntervals = async (code = 'ok') => {
    const started = await SELF.fetch(`${BASE}/auth/intervals/start`, { redirect: 'manual' });
    expect(started.status).toBe(302);
    const authorize = new URL(started.headers.get('Location')!);
    const state = authorize.searchParams.get('state')!;

    return {
      authorize,
      response: await SELF.fetch(`${BASE}/auth/intervals/callback?${new URLSearchParams({ code, state })}`, {
        headers: { Cookie: cookieFrom(started, 'workout_login') },
        redirect: 'manual',
      }),
    };
  };

  /**
   * `ACTIVITY:WRITE`, not a read beside it: the post-workout comment is a write onto
   * the activity, and their authorize page takes one permission per resource — a second
   * `ACTIVITY:` is refused with "Duplicate scope ACTIVITY". See docs/integrations.md.
   */
  it('sends the athlete to intervals.icu with the scopes the integration needs', async () => {
    const { authorize } = await signInWithIntervals();
    expect(authorize.origin).toBe('https://intervals.icu');
    expect(authorize.pathname).toBe('/oauth/authorize');
    const scope = authorize.searchParams.get('scope')!;
    expect(scope).toBe('CALENDAR:WRITE,ACTIVITY:WRITE');
    // The rule that shape exists for: one entry per resource, whatever the permissions.
    const resources = scope.split(',').map((entry) => entry.split(':')[0]);
    expect(new Set(resources).size).toBe(resources.length);
    expect(authorize.searchParams.get('redirect_uri')).toBe(`${BASE}/auth/intervals/callback`);
  });

  it('makes an account keyed on the athlete, with no address to go with it', async () => {
    const { response } = await signInWithIntervals();
    const cookie = cookieFrom(response, 'workout_session');
    expect(cookie).toBeTruthy();

    const me = await (await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).json();
    // Their OAuth hands back an athlete and nothing else: there is no email to store.
    expect(me).toMatchObject({ email: null });

    const row = await env.DB.prepare('SELECT provider, subject FROM users').first<{
      provider: string;
      subject: string;
    }>();
    expect(row).toMatchObject({ provider: 'intervals', subject: 'i99999' });
  });

  // The sign-in *is* an authorization, so asking for a second one would be theatre.
  it('leaves the athlete already connected to intervals.icu', async () => {
    const { response } = await signInWithIntervals();
    const cookie = cookieFrom(response, 'workout_session');

    const config = (await (await SELF.fetch(`${BASE}/api/config`, { headers: { Cookie: cookie } })).json()) as {
      platforms: Array<{ id: string; connected: boolean; account: string | null }>;
    };
    expect(config.platforms.find((platform) => platform.id === 'intervals')).toMatchObject({
      connected: true,
      account: 'Test Athlete',
    });
  });

  it('makes its own account rather than joining one that signed in another way', async () => {
    await signIn('google');
    await signInWithIntervals();

    const { results } = await env.DB.prepare('SELECT provider FROM users ORDER BY provider').all<{
      provider: string;
    }>();
    expect(results.map((row) => row.provider)).toEqual(['google', 'intervals']);
  });

  it('comes back to the dashboard with a message when the athlete refuses', async () => {
    const { response } = await signInWithIntervals('denied');
    expect(response.headers.get('Location')).toContain('error=');
    expect(cookieFrom(response, 'workout_session')).toBe('');
  });
});

describe('comparing a shared secret', () => {
  it('matches only an exact value, and never a missing one', async () => {
    expect(await secretsMatch('s3cret', 's3cret')).toBe(true);
    expect(await secretsMatch('s3cret', 's3crex')).toBe(false);
    // A prefix must not pass: the whole header value is the secret.
    expect(await secretsMatch('s3cre', 's3cret')).toBe(false);
    expect(await secretsMatch('s3cret ', 's3cret')).toBe(false);
    // Nothing configured is not something everything matches.
    expect(await secretsMatch('s3cret', undefined)).toBe(false);
    expect(await secretsMatch(null, 's3cret')).toBe(false);
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
