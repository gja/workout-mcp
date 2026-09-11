# Signing in

There are no passwords and no email to send: identity comes from Google, Apple
or intervals.icu. Each provider appears on the sign-in page only when its
variables are set, so **Google alone is a complete setup** — Apple is optional
and needs a paid developer account, and intervals.icu needs an OAuth client
they approve by hand.

Google and Apple are ordinary OpenID Connect authorization-code flows, handled
by [`arctic`](https://arcticjs.dev), which also builds the ES256 client-secret
JWT Apple wants in place of a static secret. intervals.icu is not OIDC and is
hand-rolled next to them. `src/identity.ts` owns all three; `src/auth.ts` turns
the resulting identity into a session or an API token.

## Google

In the Google Cloud console, create an OAuth 2.0 Client ID of type *Web
application* and add `https://<your-worker>/auth/google/callback` as an
authorized redirect URI (plus `http://localhost:8787/auth/google/callback` for
local work — Google allows loopback). Then:

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## Apple

Sign in with Apple needs an Apple Developer Program membership, which is paid.
You need a Services ID, a Team ID, and a private key (a `.p8` file) with its
Key ID. Apple will not redirect to `localhost`, so this one only works on your
real domain.

```bash
npx wrangler secret put APPLE_CLIENT_ID     # the Services ID, e.g. com.example.workouts
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY   # the .p8 contents, base64 or PEM
```

The key is stored as base64 PKCS#8; the PEM armour is stripped on read.

## intervals.icu

The same client serves both the sign-in button and connecting the platform, so
one registration covers both. It is not self-service: email them for an OAuth
app, and they hand back a client id and secret. See
[integrations.md](integrations.md) for the registration and the webhook.

```bash
npx wrangler secret put INTERVALS_CLIENT_ID
npx wrangler secret put INTERVALS_CLIENT_SECRET
```

Two redirect URIs have to be registered, because the flow ends somewhere
different depending on why it started:

| Registered URI | What finishes there |
| --- | --- |
| `/auth/intervals/callback` | A sign-in: a session is minted |
| `/auth/intervals/connect-callback` | A connection: no session is touched |

Two callbacks rather than one with a flag, because the redirect URI is sent to
their token endpoint as part of the exchange: a code issued for one cannot be
spent at the other, so the separation is enforced upstream rather than by our
own bookkeeping. The state row carries the athlete a connect belongs to, and
the callback insists it matches the session that arrives with it — a connect
link followed in a browser signed in as somebody else attaches the token to
nobody.

### It is not OpenID Connect

There is no `id_token` and no email. Their token response carries
`athlete: {id, name}`, and that athlete id is the `subject` an account is keyed
by. So an intervals.icu account has **no address at all**, which is why nothing
here authorizes on one.

The response also has no `expires_in` and no refresh token, so the access token
goes in the same encrypted column a platform credential always did, with no
refresh machinery. A grant the athlete withdraws from their settings simply
starts answering 401, which lands on the connection as a standing error.

### Signing in leaves you connected

The sign-in *is* an authorization, and it hands us the same token the connect
flow would, so asking for a second round would be theatre. Nothing is pushed at
that moment: the account a sign-in lands in is keyed on that athlete, so on a
first sign-in it is empty, and on a later one the calendar is already in step.

If `CREDENTIALS_SECRET` is unset there is nowhere safe to put the token, and the
sign-in still succeeds — it is simply not connected.

## Separate accounts, never linked

An account is keyed by *(provider, subject)*, so signing in with Google and then
with Apple makes two separate accounts, each with its own workouts. Apple's
private relay hands out a different address anyway, so there is no reliable way
to link them.

intervals.icu is **deliberately** the same. Signing in with it does not join an
account that already has that athlete connected, even though the athlete id
would match. Two reasons, and the second is the one that decided it:

- an account here is *(provider, subject)*, and quietly making one provider's
  subject resolve to another's account is a second identity model hiding inside
  the first;
- a connection is not proof of ownership in the direction that would be needed.

So one athlete can legitimately be connected to two of our users, and anything
keyed on the upstream account has to expect that — which is why the webhook
fans out to every connection it matches rather than assuming one.

## State handling

The in-flight sign-in is remembered in **two** places, and the callback insists
on both.

- A **row in D1**, holding the PKCE verifier, the return path, and — for a
  connect rather than a sign-in — the athlete it belongs to. Not a cookie,
  because Apple posts its callback cross-site, where a `SameSite=Lax` cookie
  would not be sent. Single use, with a ten-minute life; whatever the outcome,
  the row is deleted as soon as it is read.
- A **cookie in the browser**, holding the same state value. The D1 row proves
  the callback belongs to a sign-in *this server* started; it does not prove it
  belongs to *this browser's* sign-in. Without the second half an attacker can
  start a sign-in of their own and walk a victim through its callback, landing
  the victim in the attacker's account with their workouts along with it.

The login cookie is `SameSite=None` where the connection is secure, because
Apple's cross-site POST would not carry anything stricter. Browsers only accept
`None` alongside `Secure`, so plain http — localhost, where Apple cannot be
used anyway — falls back to `Lax`, which is enough for Google's top-level
redirect.

A `return_to` is only honoured when it is a same-origin path, so the sign-in
flow cannot be turned into an open redirect.

## ID tokens are not signature-checked

They do not need to be. The token arrives over TLS from the provider's own
token endpoint, in response to a request authenticated with our client secret,
which [OpenID Connect Core
3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
allows explicitly. The issuer, audience and expiry are checked anyway, since
they cost nothing and catch a misconfigured client.

## Sessions and API tokens

| Credential | Where it lives | Life |
| --- | --- | --- |
| Session cookie | SHA-256 hash in D1 | 30 days |
| API token (`wk_...`) | SHA-256 hash in D1 | Until revoked |
| OAuth access/refresh tokens | The provider's, in KV | The provider's |

Nothing is stored in the clear. The dashboard only ever shows a token prefix,
and the full value is returned exactly once, when it is minted.

The session cookie is `SameSite=Lax` rather than `Strict`, because the OAuth
consent page is reached by a top-level navigation from the MCP client. `Secure`
is dropped over plain http so the cookie also works on localhost.

A training platform's access token is the one credential that cannot be hashed,
because it has to be replayed on every push. See
[integrations.md](integrations.md).

## OAuth, for MCP clients

An MCP client gets its own grant rather than a pasted token. That half is
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
which owns everything except the consent page — see [mcp.md](mcp.md).
