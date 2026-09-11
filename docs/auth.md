# Signing in

There are no passwords and no email to send: identity comes from Google or
Apple. Each provider appears on the sign-in page only when its variables are
set, so **Google alone is a complete setup** — Apple is optional and needs a
paid developer account.

Both are ordinary OpenID Connect authorization-code flows, handled by
[`arctic`](https://arcticjs.dev), which also builds the ES256 client-secret JWT
Apple wants in place of a static secret. `src/identity.ts` owns the flows;
`src/auth.ts` turns the resulting identity into a session or an API token.

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

## Who may sign in

Anyone with a Google account can reach the button, so a public deployment
usually wants to name who may actually get in:

```bash
npx wrangler secret put ALLOWED_EMAILS      # "me@example.com,@myteam.com"
```

Entries are addresses or `@domain`, comma separated. Unset means anyone may
sign up.

An **unverified** address is weighed as if no address were given, which the
allowlist refuses: an account is keyed by *(provider, subject)*, so the address
changes nothing about who someone is, but `ALLOWED_EMAILS` is an authorization
decision made *from* the address, and an unverified one is a claim rather than
a fact. The address is still stored, for display.

## Two accounts, not one

An account is keyed by *(provider, subject)*, so signing in with Google and
then with Apple makes two separate accounts, each with its own workouts.
Apple's private relay hands out a different address anyway, so there is no
reliable way to link them.

## State handling

The in-flight sign-in is remembered in **two** places, and the callback insists
on both.

- A **row in D1**, holding the PKCE verifier and the return path. Not a cookie,
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

A training platform's API key is the one credential that cannot be hashed,
because it has to be replayed on every push. See
[integrations.md](integrations.md).

## OAuth, for MCP clients

An MCP client gets its own grant rather than a pasted token. That half is
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider),
which owns everything except the consent page — see [mcp.md](mcp.md).
