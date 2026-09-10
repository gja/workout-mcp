import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// Tests run inside workerd, so the FIT encoder and the D1 queries are
// exercised on the same runtime that serves production traffic.
export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      wrangler: { configPath: './wrangler.jsonc' },
      // No email provider is bound, so login codes are written to the log
      // and the tests read them from there.
      miniflare: { d1Databases: ['DB'], bindings: { APP_NAME: 'Workouts' } },
    }),
  ],
});
