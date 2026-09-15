// The prompt surface, and the same body behind a tool. See docs/prompts.md.

import GETTING_STARTED from './getting-started.md';

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

/** The same interview, for a caller that asks for it by name rather than picking a prompt. */
export const ONBOARDING_INSTRUCTIONS = GETTING_STARTED;
