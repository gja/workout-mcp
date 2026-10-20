// Links that carry their own query and an HMAC, so following one needs no credential and
// nothing is stored. Shared by recordings and routes. See docs/recordings.md#the-link.

import type { Env } from './db';

export class LinksUnavailable extends Error {
  constructor() {
    super('download links are not configured: set the CREDENTIALS_SECRET binding on the Worker');
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

/** `claims=…&signature=…`, both base64url, whose alphabet needs no escaping in a query string. */
export async function signClaims(env: Env, label: string, claims: object): Promise<string> {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env, label), new TextEncoder().encode(payload));
  return new URLSearchParams({ claims: payload, signature: toBase64Url(new Uint8Array(signature)) }).toString();
}

/** The signature is checked first: every claim is the caller's until it holds. */
export async function openClaims(
  env: Env,
  label: string,
  claimsParam: string | null,
  signatureParam: string | null,
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
  try {
    const claims = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (typeof claims === 'object' && claims !== null && !Array.isArray(claims)) return claims as Record<string, unknown>;
  } catch {
    // Signed but unreadable falls through to the same answer as unsigned garbage.
  }
  throw new LinkRejected('that is not a download link');
}

/** Checked after the signature, so an expired link is our own doing and can say so. */
export function checkExpiry(expiresAtSeconds: number, now: Date): void {
  if (expiresAtSeconds * 1000 <= now.getTime()) throw new LinkRejected('this link has expired; ask for a new one');
}
