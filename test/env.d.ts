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
