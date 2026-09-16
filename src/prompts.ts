// The prompt surface, and the same body behind a tool. See docs/prompts.md.

import GETTING_STARTED from "./getting-started.md";

export type Prompt = {
  name: string;
  title: string;
  /** Shown in the client's prompt picker, so it says when to reach for this one. */
  description: string;
  /** The message body, which only `prompts/get` ever sends. */
  markdown: string;
};

/** Named once, and served four ways: as a prompt, a tool, a skill, and a pointer. */
export const ONBOARDING: Prompt = {
  name: "getting-started",
  title: "Set up my training context",
  description:
    "Read whatever context is already written, interview the athlete about their sports, " +
    "goals, times, week and zones, and write workout-zones, scheduling-instructions and " +
    "current-plan from the answers.",
  markdown: GETTING_STARTED,
};

const PROMPTS: Prompt[] = [ONBOARDING];

/** The list a client reads to decide what to offer; the bodies stay behind `prompts/get`. */
export const listPrompts = () =>
  PROMPTS.map(({ markdown: _markdown, ...rest }) => rest);

export const findPrompt = (name: unknown): Prompt | undefined =>
  PROMPTS.find((prompt) => prompt.name === name);

/** Role `user`: it is the athlete asking, not an instruction the server slipped in. */
export const promptMessages = (prompt: Prompt) => ({
  description: prompt.description,
  messages: [
    { role: "user", content: { type: "text", text: prompt.markdown } },
  ],
});

/** The same interview, for a caller that asks for it by name rather than picking a prompt. */
export const ONBOARDING_INSTRUCTIONS = ONBOARDING.markdown;
