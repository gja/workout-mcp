/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` types its `env` as `Cloudflare.Env`, so point that at the
// bindings the Worker declares rather than repeating them.
type AppEnv = import('../src/db').Env;

declare namespace Cloudflare {
  /**
   * `GARMIN_STUB` exists only under test: it is the stand-in provider bound as
   * a service, so a test can read back what Garmin was sent. It is
   * deliberately not on the app's own `Env` — nothing in `src` may reach for
   * it.
   */
  interface Env extends AppEnv {
    GARMIN_STUB: Fetcher;
  }
}

declare module '*.sql?raw' {
  const content: string;
  export default content;
}

// Vite resolves `import.meta.glob` at build time; the Workers types do not
// know about it, so declare the one shape the tests use.
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, string>;
}
