// The prompt surface, and the instructions built from the same body. See docs/prompts.md.

import GETTING_STARTED from './getting-started.md';
import type { ContextDocument } from './context';

type Prompt = {
  name: string;
  title: string;
  /** Shown in the client's prompt picker, so it says when to reach for this one. */
  description: string;
  /** The message body, which only `prompts/get` ever sends. */
  markdown: string;
};

const PROMPTS: Prompt[] = [
  {
    name: 'getting-started',
    title: 'Set up my training context',
    description:
      'Read whatever context is already written, interview the athlete about their sports, ' +
      'goals, times, week and zones, and write workout-zones, scheduling-instructions and ' +
      'current-plan from the answers.',
    markdown: GETTING_STARTED,
  },
];

/** The list a client reads to decide what to offer; the bodies stay behind `prompts/get`. */
export const listPrompts = () => PROMPTS.map(({ markdown: _markdown, ...rest }) => rest);

export const findPrompt = (name: unknown): Prompt | undefined =>
  PROMPTS.find((prompt) => prompt.name === name);

/** Role `user`: it is the athlete asking, not an instruction the server slipped in. */
export const promptMessages = (prompt: Prompt) => ({
  description: prompt.description,
  messages: [{ role: 'user', content: { type: 'text', text: prompt.markdown } }],
});

// --- Server instructions -----------------------------------------------------

/**
 * Wrapped round the interview when nothing is written. The model cannot invoke a
 * prompt — only the athlete can — so an athlete who has never seen the prompt
 * picker would otherwise never be offered one.
 */
const OFFER = [
  'This athlete has written none of their context documents, so there are no zones to anchor a',
  'target to, no constraints to place a session inside, and no plan to write one for. Offer the',
  'interview below once, at a natural point. If they would rather not, or would rather type the',
  'documents on the dashboard, drop it and do not raise it again — then work from what they tell',
  'you in the moment, and say what you are assuming.',
].join(' ');

const listing = (documents: ContextDocument[]): string =>
  documents.map((document) => document.label.toLowerCase()).join(', ');

/**
 * What goes in `initialize`, which is per connection rather than per request: the
 * whole interview while it is still needed, a line while it is half done, and
 * nothing at all once it is not. The cost ends when the documents are written.
 */
export function instructionsFor(documents: ContextDocument[]): string | undefined {
  const writable = documents.filter((document) => document.writable_over_mcp);
  const missing = writable.filter((document) => document.markdown === null);
  if (missing.length === 0) return undefined;
  if (missing.length === writable.length) return `${OFFER}\n\n---\n\n${GETTING_STARTED}`;

  const written = writable.filter((document) => document.markdown !== null);
  return (
    `This athlete has written their ${listing(written)}; read that before planning. ` +
    `Not yet written: ${listing(missing)}. Ask about what is missing and write it with ` +
    'update_context, rather than planning against a default. The "getting-started" prompt is ' +
    'the whole interview, if they would rather do the lot at once.'
  );
}
