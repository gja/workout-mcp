import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { generateTestApplePrivateKey } from './test/apple-key.js';

// Tests run inside workerd, so the FIT encoder and the D1 queries are
// exercised on the same runtime that serves production traffic.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        d1Databases: ['DB'],
        kvNamespaces: ['OAUTH_KV'],
        bindings: {
          APP_NAME: 'Workouts',
          GOOGLE_CLIENT_ID: 'test-google-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-google-secret',
          APPLE_CLIENT_ID: 'com.example.workouts',
          APPLE_TEAM_ID: 'TEAM123456',
          APPLE_KEY_ID: 'KEY1234567',
          APPLE_PRIVATE_KEY: await generateTestApplePrivateKey(),
          GARMIN_CLIENT_ID: 'test-garmin-client',
          GARMIN_CLIENT_SECRET: 'test-garmin-secret',
          // Set explicitly so the token sealing is exercised on its own key
          // rather than on the client secret's fallback.
          GARMIN_ENCRYPTION_KEY: 'test-garmin-encryption-key',
        },
        // The same stand-in, reachable from a test as well as from the Worker,
        // so a test can ask what Garmin was actually sent.
        serviceBindings: { GARMIN_STUB: 'upstream-provider' },
        // Every outbound fetch goes to the stand-in provider instead of the
        // internet, so the real arctic and Garmin code paths still run.
        outboundService: { name: 'upstream-provider' },
        workers: [
          {
            name: 'upstream-provider',
            modules: true,
            script: readFileSync('./test/upstream-provider.js', 'utf8'),
            modulesRoot: '/',
          },
        ],
      },
    })),
  ],
});
