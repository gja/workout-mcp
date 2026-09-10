/**
 * Sealing Garmin's tokens for storage.
 *
 * Every other credential in this app is stored as a hash, because all it ever
 * has to do is answer "is this the same string?". Garmin's access and refresh
 * tokens are different: we have to hand the real value back to Garmin on every
 * call, so they have to be recoverable — and a recoverable secret in a shared
 * database wants encrypting.
 *
 * AES-GCM with a key derived from a configured secret. The nonce is random per
 * seal and stored alongside the ciphertext, so the same token sealed twice
 * looks different both times.
 */

const ALGORITHM = 'AES-GCM';
const NONCE_BYTES = 12;

/**
 * Which secret the tokens are sealed with.
 *
 * `GARMIN_ENCRYPTION_KEY` if it is set, and the client secret otherwise, so a
 * self-hoster has one fewer thing to generate. The trade is that rotating the
 * client secret without a standalone encryption key set makes the stored
 * tokens unreadable — which `keyId` turns into a clear "reconnect" rather than
 * a decryption failure.
 */
export const encryptionSecret = (env: {
  GARMIN_ENCRYPTION_KEY?: string;
  GARMIN_CLIENT_SECRET?: string;
}): string | null => env.GARMIN_ENCRYPTION_KEY || env.GARMIN_CLIENT_SECRET || null;

const encoder = new TextEncoder();

const base64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const unbase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

/**
 * A short, non-reversible name for the sealing key.
 *
 * Stored next to the ciphertext so a row sealed with a since-rotated secret is
 * recognised as such before anything tries to open it. It is a digest of the
 * secret truncated to eight bytes, so it identifies the key without being a
 * foothold on the secret itself.
 */
export async function keyId(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`garmin-key-id ${secret}`));
  return base64(new Uint8Array(digest).slice(0, 8));
}

/**
 * The AES key for a secret.
 *
 * HKDF rather than using the secret's bytes directly, because the secret is a
 * printable string of whatever length Garmin issued rather than 32 bytes of
 * key material. The salt is fixed: there is one key per deployment, and a
 * per-row salt would have to be stored per row to be re-derived anyway.
 */
async function sealingKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('workout-mcp/garmin'), info: encoder.encode('token-seal') },
    material,
    { name: ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** `base64(nonce || ciphertext)`. */
export async function seal(secret: string, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: ALGORITHM, iv: nonce }, await sealingKey(secret), encoder.encode(plaintext)),
  );

  const out = new Uint8Array(nonce.length + sealed.length);
  out.set(nonce);
  out.set(sealed, nonce.length);
  return base64(out);
}

/** The inverse. Returns null for anything that will not open. */
export async function unseal(secret: string, sealed: string): Promise<string | null> {
  try {
    const bytes = unbase64(sealed);
    if (bytes.length <= NONCE_BYTES) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: ALGORITHM, iv: bytes.slice(0, NONCE_BYTES) },
      await sealingKey(secret),
      bytes.slice(NONCE_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * A stable hash of a pushed payload, used to skip a sync that would change
 * nothing. Not a secret, so a plain digest with no key involved.
 */
export async function fingerprint(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(value)));
  return base64(new Uint8Array(digest).slice(0, 16));
}
