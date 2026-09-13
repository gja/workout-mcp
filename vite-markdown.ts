import type { Plugin } from 'vite';

/**
 * Markdown as a string, so a document that is prose stays a `.md` file rather
 * than being escaped into a template literal. `enforce: 'pre'` and `transform`:
 * the file arrives here as its own text, and has to leave as JavaScript before
 * anything downstream tries to parse it as such.
 */
export const markdown = (): Plugin => ({
  name: 'markdown-as-string',
  enforce: 'pre',
  transform(code, id) {
    if (!id.endsWith('.md')) return null;
    return { code: `export default ${JSON.stringify(code)};`, map: null };
  },
});
