/// <reference types="@cloudflare/vitest-pool-workers/types" />

// `cloudflare:test` types its `env` as `Cloudflare.Env`, so point that at the
// bindings the Worker declares rather than repeating them.
type AppEnv = import('../src/db').Env;

declare namespace Cloudflare {
  interface Env extends AppEnv {}
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
