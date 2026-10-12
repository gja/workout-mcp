// A one-line description turned into workout JSON by a small Workers AI model. It only
// drafts: nothing is saved here. See docs/quick-add.md.

import { readContext } from './context';
import type { Env } from './db';
import { describeWorkout } from './describe';
import { fail, parseDate } from './units';
import type { WorkoutInput } from './workout';
import { parseWorkout } from './workout';

/** Cheap and good enough at JSON; swap for `@cf/meta/llama-3.2-1b-instruct` to halve the cost. */
export const DRAFT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8-fast';

export const MAX_DESCRIPTION_LENGTH = 500;

const MAX_OUTPUT_TOKENS = 1024;

/** Present when the binding is and nobody has set `QUICK_ADD` to `off`. */
export const quickAddEnabled = (env: Env): boolean => Boolean(env.AI) && env.QUICK_ADD !== 'off';

const SYSTEM_PROMPT = `You convert a short workout description into JSON. Reply with one JSON object and nothing else.

Shape:
{"name": string, "sport": "running"|"cycling"|"swimming"|"walking"|"hiking"|"rowing"|"training", "notes": string, "steps": [step]}

A step is either {"repeat": number, "steps": [step]} or
{"name": string, "intensity": "warmup"|"active"|"interval"|"rest"|"recovery"|"cooldown", one duration, at most one target}.

Durations: "goal_s" (seconds, or "mm:ss"), "goal_meters", "goal_km". Leave the duration out to run until a lap press.
Targets: "target_pace_km": ["m:ss","m:ss"], "target_heart_rate": [low, high] in bpm, "target_watts": [low, high], "target_hr_zone": 1-5, "target_power_zone": 1-7. Use "-" for an open end, e.g. ["-","6:30"] for an easy cap.
Take every number from the athlete's zones below: match words like easy, tempo, threshold, race pace or strides to the row with that name, and copy its range. Paces there are min/km. Omit a target the description does not imply.

Example: "easy 20 min then 6x 1 min hard 1 min easy"
{"name":"Easy run with 6x1min","sport":"running","notes":"","steps":[{"name":"Easy","intensity":"active","goal_s":1200},{"repeat":6,"steps":[{"name":"Hard","intensity":"interval","goal_s":60},{"name":"Easy","intensity":"recovery","goal_s":60}]}]}`;

/** The first `{` to the last `}`: small models wrap JSON in prose or a code fence. */
function extractJson(reply: string): unknown {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) fail('', 'the model did not answer with JSON');
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return fail('', 'the model answered with JSON that does not parse');
  }
}

/** The model's text, from a `{response}` object or a bare string as some models give. */
const replyText = (result: unknown): string => {
  if (typeof result === 'string') return result;
  const response = (result as { response?: unknown } | null)?.response;
  if (typeof response === 'string') return response;
  // A model may parse the JSON itself and hand back an object.
  return response && typeof response === 'object' ? JSON.stringify(response) : '';
};

/** Every failure on the model's side reads the same: quick add is a shortcut, Claude is the way. */
export const QUICK_ADD_FAILED = 'Something went wrong with quick add. Please use Claude to plan this workout.';

/** `summary` is the same prose a saved workout reads back with, so the athlete can judge it before saving. */
export type Draft = { workout: WorkoutInput; summary: string };

/**
 * Null when the model failed or drafted something that does not validate; the reason is
 * logged, not returned. Validated by the parser a create uses, so a draft that comes back will save.
 */
export async function draftWorkout(env: Env, userId: string, body: unknown): Promise<Draft | null> {
  const raw = (body ?? {}) as { date?: unknown; description?: unknown };
  const date = parseDate(raw.date, 'date');
  if (typeof raw.description !== 'string' || raw.description.trim() === '') {
    fail('description', 'describe the workout in a sentence or two');
  }
  const description = (raw.description as string).trim();
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    fail('description', `at most ${MAX_DESCRIPTION_LENGTH} characters, got ${description.length}`);
  }

  // Whole: the bands for a sport can sit thousands of characters in, and the document is already capped.
  const zones = (await readContext(env, userId, 'workout-zones')).markdown;
  let reply = '';
  try {
    const result = await env.AI!.run(DRAFT_MODEL, {
      messages: [
        { role: 'system', content: `${SYSTEM_PROMPT}\n\nAthlete's zones:\n${zones ?? '(none given; prefer zone targets)'}` },
        { role: 'user', content: description },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
    });
    reply = replyText(result);
    const drafted = extractJson(reply) as Record<string, unknown>;
    // The day is the athlete's, never the model's.
    const workout = parseWorkout({ ...drafted, date });
    return { workout, summary: describeWorkout(workout) };
  } catch (err) {
    console.error('quick add failed', (err as Error).message, reply);
    return null;
  }
}
