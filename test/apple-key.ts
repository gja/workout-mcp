/**
 * A throwaway P-256 key so the Apple client can build its ES256 client secret
 * during tests. Generated per run; it never leaves the test process.
 *
 * The public half goes to the stand-in provider, which verifies the secret the
 * way Apple does — the one check that tells a valid ES256 JWT from a plausible one.
 */
export async function generateTestAppleKeyPair(): Promise<{ privateKey: string; publicJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return {
    privateKey: Buffer.from(pkcs8).toString('base64'),
    publicJwk: (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey,
  };
}
