# Signing in

No passwords and no email: identity comes from Google, Apple or intervals.icu. Each
provider appears only when its variables are set, so **Google alone is a complete
setup**. Google and Apple are ordinary OIDC authorization-code flows on
[`arctic`](https://arcticjs.dev), which also builds the ES256 client-secret JWT Apple
wants. `src/identity.ts` owns all three; `src/auth.ts` turns the result into a session or
an API token.

## Google

An OAuth 2.0 Client ID of type *Web application*, with
`https://<your-worker>/auth/google/callback` as a redirect URI (plus the localhost one —
Google allows loopback).

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

## Apple

Needs a paid developer membership: a Services ID, a Team ID, and a `.p8` key with its Key
ID. Apple will not redirect to `localhost`, so this only works on a real domain.

```bash
npx wrangler secret put APPLE_CLIENT_ID     # the Services ID, e.g. com.example.workouts
npx wrangler secret put APPLE_TEAM_ID
npx wrangler secret put APPLE_KEY_ID
npx wrangler secret put APPLE_PRIVATE_KEY   # the .p8 contents, base64 or PEM
npx wrangler secret put APPLE_APP_ID        # the iOS bundle id — only the app needs it
```

Stored as base64 PKCS#8; PEM armour is stripped on read. `APPLE_APP_ID` is not a secret,
only deployment configuration, and a `vars` entry does just as well.

**The app signs in natively, and the two are one account.** `POST /api/apple-session` takes
the authorization code Apple's own sheet produced and answers with a `wk_` token — no
browser, no OAuth round trip, no session. The code is spent server-side because spending it
needs the team's key: the ID token then arrives over TLS from Apple's token endpoint against
our client secret, exactly as the browser flow's does, so it is read the same way. What
differs is the audience — the bundle id, not the Services ID — and the absence of a
`redirect_uri`, which Apple refuses from a client that has none. `arctic`'s exchange always
sends one, so that one JWT is built in `src/identity.ts` rather than by it.

The subject is Apple's, and Apple scopes it to the **developer team**, not to the client
that asked. So the phone and the browser return the same `sub` and land on the same
`(provider, subject)` row — provided the Services ID's primary App ID is the app's. Get that
wrong and an athlete has two rows, which only a shared verified address would join.

An address the account already has survives a sign-in that carries none: Apple sends one
through the browser and can leave it out of a native round, and a blank is not a change of
address. Nothing authorizes on it either way.

The route is unauthenticated because the code *is* the credential: Apple issues it for this
team alone, it is single use, and it is worth nothing to anyone who cannot sign the client
secret. It mints a token directly rather than a session, which is all the app ever wanted —
listed under *API tokens* like any other, and revoked there.

## intervals.icu

One registration serves both the sign-in button and connecting the platform. Not
self-service — email them for an OAuth app. See [integrations.md](integrations.md).

```bash
npx wrangler secret put INTERVALS_CLIENT_ID
npx wrangler secret put INTERVALS_CLIENT_SECRET
```

Two redirect URIs, because the redirect URI is part of the token exchange and so a code
issued for a sign-in cannot be spent on a connect: `/auth/intervals/callback` mints a
session, `/auth/intervals/connect-callback` touches none. The state row carries the
athlete a connect belongs to, and the callback insists it matches the session.

**It is not OIDC.** No `id_token` and no email — their token response carries
`athlete: {id, name}`, and that id is the `subject`. So an intervals.icu account has no
address at all, which is why nothing here authorizes on one. No `expires_in` and no
refresh token either, so the access token goes in the encrypted platform-credential
column with no refresh machinery; a withdrawn grant simply starts answering 401.

**Signing in leaves you connected**: the sign-in *is* the authorization, and hands us the
same token a connect would. With `CREDENTIALS_SECRET` unset the sign-in still succeeds,
just unconnected.

## One account, however you sign in

A row in `users` is still keyed by *(provider, subject)*, but a row is no longer the same
thing as an account. `alias_of_user_id` is null for an account and names the account for a
sign-in linked to one, so signing in with Apple after Google reaches what Google made
instead of a second, empty account. Sessions, tokens and every workout hang off the
account; a linked row owns nothing, and a session cut before the link was made is resolved
through it on the way in.

**The link is made on a verified address, and on nothing else.** A sign-in whose provider
vouches for an address another sign-in has already proved attaches to that account, oldest
first. An address nobody vouched for links nothing, which is why `email_verified` is stored
rather than read and thrown away, and intervals.icu — which returns no address at all —
never links to anything.

That trusts each provider to hand back an address it has checked, which Google and Apple
both do. It is the weakest part of this: an address is an identifier the provider controls,
so a domain that changes hands changes who a future sign-in becomes. Nothing here
authorizes on the address itself, and a sign-in still has to pass the provider first.

**Hide My Email means there is nothing to match.** Apple's relay hands out a different
address per Services ID, so an athlete who hides theirs looks like a different person to
the only signal there is, and gets the second account this section is about. The native
sign-in and the browser one share the relay address, since Apple scopes both to the team —
but Apple and Google will not.

**Only a sign-in this server has never seen is linked.** A row that already has an account
keeps it, whatever its address matches. Otherwise the first athlete to sign in after a
deploy would be the one demoted — and the workouts under the row that stopped being an
account would go with it, since everything hangs off the account's id.

So migration `0015` adds the column and touches no row's account. Two accounts already made
stay two, and either **delete one** — the next sign-in with that provider is a new row,
which then finds the one that is left — or link them by hand:

```bash
# Check the row about to become a link owns nothing first.
npx wrangler d1 execute workout-mcp --remote \
  --command "SELECT COUNT(*) FROM workouts WHERE user_id = '<the other row>'"

npx wrangler d1 execute workout-mcp --remote \
  --command "UPDATE users SET alias_of_user_id = '<the account>' WHERE id = '<the other row>'"
```

A link made either way reaches backwards: sessions, API tokens and OAuth grants name the
row they were made under, and each is resolved through it on the way in. What does **not**
move is anything the demoted row owns — workouts, contexts, a connected platform — so a
row with data of its own is a merge rather than a link, and this is not that.

## State handling

The in-flight sign-in is remembered in **two** places and the callback insists on both.

- A **row in D1** with the PKCE verifier, the return path and (for a connect) the athlete.
  Not a cookie, because Apple posts its callback cross-site where `SameSite=Lax` would not
  be sent. Single use, ten minutes, deleted as soon as it is read.
- A **cookie** with the same state value. The row proves the callback belongs to a sign-in
  *this server* started; the cookie proves it belongs to *this browser's*. Without the
  second, an attacker starts a sign-in, walks a victim through its callback, and lands the
  victim in the attacker's account.

The login cookie is `SameSite=None` where the connection is secure, because Apple's
cross-site POST would not carry anything stricter; plain http falls back to `Lax`.
`return_to` is only honoured for a same-origin path.

ID tokens are **not** signature-checked. They arrive over TLS from the provider's own
token endpoint against our client secret, which [OIDC Core
3.1.3.7](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation) allows.
Issuer, audience and expiry are checked anyway.

## Sessions and API tokens

| Credential | Where it lives | Life |
| --- | --- | --- |
| Session cookie | SHA-256 hash in D1 | 30 days |
| API token (`wk_...`) | SHA-256 hash in D1 | Until revoked |
| OAuth access/refresh tokens | The provider's, in KV | The provider's |

The full token value is returned exactly once; the dashboard shows a prefix. The session
cookie is `SameSite=Lax` rather than `Strict`, because the OAuth consent page is reached
by a top-level navigation from the MCP client. A platform's access token is the one
credential that cannot be hashed — see [integrations.md](integrations.md).

## A native app signs in through the browser, and ends up with a token

The provider validates OAuth tokens only on its own routes, so an access token reaches
`/mcp` and is a 401 against `/api/`. Fine for an MCP client, no use to the
[iOS app](ios.md).

`POST /api/app-token` is registered as an API route on the provider, so the grant is
checked by the library that issued it, and answers with a freshly minted `wk_` token. An
app does the ordinary PKCE round trip, trades the grant once, and holds what every other
REST caller holds — no second handshake to invent, and it is revocable under *API tokens*.

**Behind a scope of its own**, `app-token`, because the token outlives the grant: a grant
carrying only `workouts` is refused with a 403, so a client that wants it asks by name and
the consent page shows it. Nothing else reads the granted scopes.

**The app names the sign-in it was asked for.** Its own screen lists whatever
`GET /auth/providers` says this deployment has, and the button that was pressed adds
`provider=apple` to the authorization request. It is not an OAuth parameter and the
provider ignores it: the consent page reads it, and an athlete who is not signed in goes
straight to `/auth/apple/start` rather than being asked the same question a second time. A
hint naming a provider this deployment has not configured falls back to the buttons — so
does a sign-in that has just failed, whose message would otherwise be redirected past.
