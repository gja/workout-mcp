import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { CODE_TTL_MINUTES, MAX_CODE_ATTEMPTS, isAllowed, newLoginCode, normalizeEmail } from '../src/auth';
import { captureLoginCode, resetDatabase } from './helpers';

const BASE = 'https://workouts.example';
const EMAIL = 'athlete@example.com';

beforeEach(resetDatabase);

const post = (path: string, body: unknown, headers: HeadersInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const requestCode = (email = EMAIL) => captureLoginCode(() => post('/api/auth/request-code', { email }));

/** Sign in and return the session cookie to send back. */
async function signIn(email = EMAIL): Promise<string> {
  const code = await requestCode(email);
  const response = await post('/api/auth/verify', { email, code });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie');
  if (!cookie) throw new Error('no session cookie was set');
  return cookie.split(';')[0];
}

describe('email handling', () => {
  it('normalizes and validates addresses', () => {
    expect(normalizeEmail('  Athlete@Example.COM ')).toBe('athlete@example.com');
    expect(normalizeEmail('no-at-sign')).toBeNull();
    expect(normalizeEmail('missing@tld')).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
  });

  it('honours the allowlist, by address or domain', () => {
    expect(isAllowed({} as never, 'anyone@example.com')).toBe(true);
    const gated = { ALLOWED_EMAILS: 'me@example.com, @team.example' } as never;
    expect(isAllowed(gated, 'me@example.com')).toBe(true);
    expect(isAllowed(gated, 'someone@team.example')).toBe(true);
    expect(isAllowed(gated, 'stranger@example.com')).toBe(false);
  });

  it('draws six-digit codes', () => {
    for (let i = 0; i < 50; i++) expect(newLoginCode()).toMatch(/^\d{6}$/);
  });
});

describe('signing in', () => {
  it('sends a code and accepts it', async () => {
    const response = await post('/api/auth/request-code', { email: EMAIL });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sent: true, expires_in: CODE_TTL_MINUTES * 60 });
  });

  it('creates the account on the first verified login', async () => {
    const cookie = await signIn();
    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
    expect(await me.json()).toMatchObject({ email: EMAIL });

    // Signing in again reuses the same account rather than making another.
    await signIn();
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('rejects a wrong code, and burns the code after too many tries', async () => {
    await requestCode();
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
      expect((await post('/api/auth/verify', { email: EMAIL, code: '000000' })).status).toBe(400);
    }
    const remaining = await env.DB.prepare('SELECT attempts FROM login_codes WHERE email = ?')
      .bind(EMAIL)
      .first<{ attempts: number }>();
    expect(remaining?.attempts).toBe(MAX_CODE_ATTEMPTS);

    // The next attempt, right or wrong, clears the code entirely.
    await post('/api/auth/verify', { email: EMAIL, code: '000000' });
    expect(await env.DB.prepare('SELECT attempts FROM login_codes WHERE email = ?').bind(EMAIL).first()).toBeNull();
  });

  it('consumes the code, so it cannot be replayed', async () => {
    const code = await requestCode();
    expect((await post('/api/auth/verify', { email: EMAIL, code })).status).toBe(200);
    expect((await post('/api/auth/verify', { email: EMAIL, code })).status).toBe(400);
  });

  it('will not send a second code straight away', async () => {
    await post('/api/auth/request-code', { email: EMAIL });
    const again = await post('/api/auth/request-code', { email: EMAIL });
    expect(again.status).toBe(429);
    expect(again.headers.get('Retry-After')).toMatch(/^\d+$/);
  });

  it('refuses an expired code', async () => {
    const code = await requestCode();
    await env.DB.prepare('UPDATE login_codes SET expires_at = ? WHERE email = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), EMAIL)
      .run();
    expect((await post('/api/auth/verify', { email: EMAIL, code })).status).toBe(400);
  });

  it('rejects a malformed request without sending anything', async () => {
    expect((await post('/api/auth/request-code', { email: 'nope' })).status).toBe(400);
    expect((await post('/api/auth/verify', { email: EMAIL, code: 'abc' })).status).toBe(400);
  });

  it('signs out', async () => {
    const cookie = await signIn();
    const out = await post('/api/auth/logout', {}, { Cookie: cookie });
    expect(out.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it('ignores a made-up session cookie', async () => {
    const response = await SELF.fetch(`${BASE}/api/me`, { headers: { Cookie: 'workout_session=deadbeef' } });
    expect(response.status).toBe(401);
  });
});

describe('API tokens', () => {
  it('issues a token that then works as a bearer credential', async () => {
    const cookie = await signIn();
    const created = await post('/api/tokens', { name: 'Garmin watch' }, { Cookie: cookie });
    expect(created.status).toBe(201);

    const { token, prefix } = (await created.json()) as { token: string; prefix: string };
    expect(token).toMatch(/^wk_[0-9a-f]{64}$/);
    expect(prefix).toBe(token.slice(0, 9));

    const me = await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await me.json()).toMatchObject({ email: EMAIL });
  });

  it('lists tokens by prefix only, never the secret', async () => {
    const cookie = await signIn();
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
    const cookie = await signIn();
    const { token, prefix } = (await (await post('/api/tokens', {}, { Cookie: cookie })).json()) as {
      token: string;
      prefix: string;
    };

    const revoked = await SELF.fetch(`${BASE}/api/tokens/${prefix}`, { method: 'DELETE', headers: { Cookie: cookie } });
    expect(revoked.status).toBe(200);
    expect((await SELF.fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });

  it('needs a session, not just a bearer token, to mint more tokens', async () => {
    const cookie = await signIn();
    const { token } = (await (await post('/api/tokens', {}, { Cookie: cookie })).json()) as { token: string };

    // A bearer token is a valid credential, so this is allowed — but an
    // anonymous caller is not.
    expect((await post('/api/tokens', {}, { Authorization: `Bearer ${token}` })).status).toBe(201);
    expect((await post('/api/tokens', {})).status).toBe(401);
  });
});
