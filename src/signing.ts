// Links that carry their own query and an HMAC, so following one needs no credential and
// nothing is stored. Shared by recordings and routes. See docs/recordings.md#the-link.

import type { Env } from './db';
import { Unavailable } from './errors';

export class LinksUnavailable extends Unavailable {
  constructor() {
    super('download links are not configured: set the CREDENTIALS_SECRET binding on the Worker', 503);
  }
}

/** Why a link did not open, in the words the response gives back. */
export class LinkRejected extends Error {}

export const linksConfigured = (env: Env): boolean => Boolean(env.CREDENTIALS_SECRET);

/** The label domain-separates each kind of link, and both from `src/platforms/store.ts`'s key. */
async function signingKey(env: Env, label: string): Promise<CryptoKey> {
  if (!env.CREDENTIALS_SECRET) throw new LinksUnavailable();
  const material = new TextEncoder().encode(`${label}\n${env.CREDENTIALS_SECRET}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

export type Link = { url: string; expires_at: string };

type Where = { origin: string; path: string; ttlSeconds: number; now: Date };

/**
 * `<path>?claims=…&signature=…`, both base64url, whose alphabet needs no escaping in a query
 * string. The claims gain `v`, a version so a later shape can be told from a forgery, and
 * `x`, the expiry in epoch seconds.
 */
export async function signLink(env: Env, label: string, where: Where, claims: object): Promise<Link> {
  const expiresAt = new Date(where.now.getTime() + where.ttlSeconds * 1000);
  const signed = { v: 1, ...claims, x: Math.floor(expiresAt.getTime() / 1000) };
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(signed)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env, label), new TextEncoder().encode(payload));
  const search = new URLSearchParams({ claims: payload, signature: toBase64Url(new Uint8Array(signature)) });
  return { url: `${where.origin}${where.path}?${search}`, expires_at: expiresAt.toISOString() };
}

/** The signature is checked first: every claim is the caller's until it holds. */
export async function openLink(
  env: Env,
  label: string,
  claimsParam: string | null,
  signatureParam: string | null,
  now: Date,
): Promise<Record<string, unknown>> {
  if (!claimsParam || !signatureParam) throw new LinkRejected('that is not a download link');

  const signature = fromBase64Url(signatureParam);
  if (!signature) throw new LinkRejected('that is not a download link');

  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(env, label),
    signature,
    new TextEncoder().encode(claimsParam),
  );
  if (!valid) throw new LinkRejected('this link has been altered, or was signed by someone else');

  const body = fromBase64Url(claimsParam);
  if (!body) throw new LinkRejected('that is not a download link');
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new LinkRejected('that is not a download link');
  }

  // Signed, so this is our own doing: a link from a version that wrote a different shape.
  const shaped = claims as Record<string, unknown> | null;
  if (typeof shaped !== 'object' || shaped === null || shaped.v !== 1 || typeof shaped.x !== 'number') {
    throw new LinkRejected(OLDER_VERSION);
  }
  if (shaped.x * 1000 <= now.getTime()) throw new LinkRejected('this link has expired; ask for a new one');
  return shaped;
}

/** For a caller whose own claims turn out to be the wrong shape, after the signature held. */
export const OLDER_VERSION = 'this link was made by an older version and cannot be read';
