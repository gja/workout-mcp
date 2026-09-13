import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { markdown } from './vite-markdown';
import { generateTestApplePrivateKey } from './test/apple-key.js';
import { generateTestDrivePrivateKey } from './test/drive-key.js';

// Tests run inside workerd, so the FIT encoder and the D1 queries are
// exercised on the same runtime that serves production traffic.
export default defineConfig({
  plugins: [
    markdown(),
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
          CREDENTIALS_SECRET: 'test-credentials-secret',
          INTERVALS_CLIENT_ID: 'test-intervals-client',
          INTERVALS_CLIENT_SECRET: 'test-intervals-secret',
          INTERVALS_WEBHOOK_SECRET: 'test-intervals-webhook-secret',
          INTERVALS_WEBHOOK_AUTHORIZATION: 'test-intervals-webhook-header',
          GOOGLE_DRIVE_CLIENT_EMAIL: 'workouts@test-project.iam.gserviceaccount.com',
          GOOGLE_DRIVE_PRIVATE_KEY: await generateTestDrivePrivateKey(),
        },
        // Every outbound fetch goes to the stand-in provider instead of the
        // internet, so the real arctic code path still runs.
        outboundService: { name: 'upstream-provider' },
        // The same Worker, reachable from a test: the intervals.icu stand-in
        // keeps state, and a test has to be able to arrange and read it.
        serviceBindings: { INTERVALS: 'upstream-provider' },
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
