/**
 * A throwaway P-256 key so the Apple client can build its ES256 client secret
 * during tests. Generated per run; it never leaves the test process.
 */
export async function generateTestApplePrivateKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return Buffer.from(pkcs8).toString('base64');
}
