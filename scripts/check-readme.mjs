// Enforces the README's own rule: one entry per docs/ file, 50-100 words each.
import { readdirSync, readFileSync } from 'node:fs';

const MIN = 50;
const MAX = 100;

const readme = readFileSync('README.md', 'utf8').split('\n');
const entries = new Map();

let current = null;
for (const line of readme) {
  const heading = /^### \[docs\/([a-z-]+\.md)\]/.exec(line);
  if (heading) {
    current = heading[1];
    entries.set(current, 0);
    continue;
  }
  if (/^(#{1,3} |---$)/.test(line)) current = null;
  else if (current) entries.set(current, entries.get(current) + line.split(/\s+/).filter(Boolean).length);
}

const problems = [];
for (const [doc, words] of entries) {
  if (words < MIN || words > MAX) problems.push(`docs/${doc}: ${words} words, expected ${MIN}-${MAX}`);
}
for (const doc of readdirSync('docs').filter((f) => f.endsWith('.md'))) {
  if (!entries.has(doc)) problems.push(`docs/${doc}: no entry in the README`);
}

if (problems.length > 0) {
  console.error('README index is out of bounds:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`README index ok: ${entries.size} docs, all ${MIN}-${MAX} words`);
