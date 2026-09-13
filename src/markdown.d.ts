// Markdown imports are strings: `vite-markdown.ts` does it for Vite and vitest,
// the `Text` rule in wrangler.jsonc for the esbuild bundle `wrangler deploy` makes.

declare module '*.md' {
  const content: string;
  export default content;
}
