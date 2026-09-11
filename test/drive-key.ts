/**
 * A throwaway RSA key so the Drive service account can sign its own JWT during
 * tests. Generated per run, and PEM-armoured the way Google's downloaded JSON
 * carries it, so the parsing in `src/drive/google.ts` is exercised too.
 */
export async function generateTestDrivePrivateKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;

  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const body = Buffer.from(pkcs8).toString('base64').replace(/.{64}/g, '$&\n');
  return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
}
