import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

// The Cloudflare plugin builds the Worker and the client together and runs the
// Worker in workerd during `vite dev`, so the dashboard develops against real
// D1 and KV bindings rather than a mock.
export default defineConfig({
  plugins: [react(), cloudflare()],
  environments: {
    // Scoped to the client: the Worker environment has its own entry, and a
    // top-level `input` would be applied to that too.
    client: {
      build: {
        rollupOptions: {
          // Two pages: the dashboard, and the OAuth consent screen the Worker
          // serves at /oauth/authorize.
          input: { index: 'index.html', authorize: 'authorize.html' },
        },
      },
    },
  },
});
