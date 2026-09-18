// The tool surface, shared by MCP and REST. The schemas are what an assistant
// reads before writing a workout, so they carry the examples. See docs/mcp.md.

import { base64Encode, encodeWorkoutFit, fitDownloadName } from './fit';
import { describeWorkout, plannedTotals } from './describe';
import * as db from './db';
import type { Env, User } from './db';
import * as context from './context';
import * as plan from './plan';
import { ONBOARDING_INSTRUCTIONS } from './prompts';
import { PLATFORMS } from './platforms';
import * as recordings from './recordings';
import { WorkoutError, parseComment, parseWorkout } from './workout';
import type { Workout } from './workout';
import { parseDate, parseTimestamp } from './units';
import { MAX_COMMENT_LENGTH, MAX_TAGS, MAX_TAG_LENGTH, SPORTS } from './workout';

const RANGE_DOC =
  'A range as [floor, ceiling]; either end may be "-" to leave it open, ' +
  'so [140, "-"] means above 140 and ["-", 150] means below 150. ' +
  'A single value sets both ends.';

const PACE_RANGE_DOC =
  'A pace range as "mm:ss". The first entry is the floor on effort and the second the ceiling, ' +
  'and since a lower pace number is faster that reads as ["6:30", "-"] = faster than 6:30 and ' +
  '["-", "8:00"] = slower than 8:00. A two-sided band such as ["4:00", "4:15"] means the same ' +
  'either way round. A single value sets both ends.';

const ZONE_DOC =
  'Either a single zone, which the watch resolves against its own configuration, ' +
  'or a two-entry range of zone boundaries on a continuous scale, which is converted ' +
  'to a percentage band. The endpoints are boundaries, so ["2", "3"] is exactly zone 2 ' +
  'and all of zones 2 and 3 is ["2", "4"]. Fractional boundaries such as "2.5" are allowed.';

const zone = (description: string) => ({
  description: `${description} ${ZONE_DOC}`,
  oneOf: [
    { type: 'number' },
    { type: 'array', items: { type: ['string', 'number'] }, minItems: 1, maxItems: 2 },
  ],
});

const range = (description: string, doc: string = RANGE_DOC) => ({
  description: `${description} ${doc}`,
  oneOf: [
    { type: 'array', items: { type: ['string', 'number'] }, minItems: 1, maxItems: 2 },
    { type: ['string', 'number'] },
  ],
});

export const STEP_SCHEMA = {
  type: 'array',
  minItems: 1,
  description:
    'The steps of the workout, in order. A step either does something ' +
    '(a duration plus optional targets) or repeats a group of steps. ' +
    'Give a step at most one duration; a step with no duration runs until the ' +
    'lap button is pressed. A step may carry up to two targets on different ' +
    'metrics — pace plus cadence, say — and the one nearer the front of ' +
    'pace, power, heart rate, cadence becomes the primary. Example: ' +
    '[{"name":"Warmup","goal_s":600,"target_heart_rate":[146,153]},' +
    '{"repeat":8,"steps":[{"name":"Fast","goal_meters":400,"target_pace_km":["4:00","4:15"]},' +
    '{"name":"Float","goal_s":90,"target_pace_km":["-","6:30"]}]},' +
    '{"name":"Cooldown","goal_s":600}]',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Step name shown on the watch, e.g. "Warmup", "400m rep".' },
      notes: {
        type: 'string',
        description: 'Longer note shown on the watch. Cut past about 250 characters, as the session note is.',
      },
      intensity: {
        type: 'string',
        enum: ['warmup', 'active', 'interval', 'rest', 'recovery', 'cooldown'],
        description: 'Defaults to a guess from the step name, or "interval" inside a repeat.',
      },

      goal_s: { type: ['number', 'string'], description: 'Run for this long. Seconds, or "mm:ss" / "hh:mm:ss".' },
      goal_meters: { type: 'number', description: 'Run for this distance in metres, e.g. 400.' },
      goal_km: { type: 'number', description: 'Run for this distance in kilometres.' },
      goal_miles: { type: 'number', description: 'Run for this distance in miles.' },
      goal_yards: { type: 'number', description: 'Swim or run for this distance in yards.' },

      target_pace_km: range('Target pace per kilometre.', PACE_RANGE_DOC),
      target_pace_miles: range('Target pace per mile.', PACE_RANGE_DOC),
      target_heart_rate: range('Target heart rate in bpm, or "85%" for a percentage of max HR.'),
      target_watts: range('Target power in watts, or "95%" for a percentage of FTP.'),
      target_cadence: range('Target cadence in rpm (or steps per minute).'),
      target_hr_zone: zone('Heart-rate zone 1-5, as configured on the watch.'),
      target_power_zone: zone('Power zone 1-7, as configured on the watch.'),
      target_pace_zone: {
        type: 'number',
        description:
          'Pace/speed zone 1-10, as configured on the watch. Unlike the other zones this takes ' +
          'a single zone only — FIT has no percentage speed target, so use target_pace_km for a band.',
      },

      repeat: { type: 'number', description: 'Repeat the nested steps this many times. Use with "steps".' },
      steps: { type: 'array', description: 'The steps to repeat. Only valid alongside "repeat".' },
    },
    additionalProperties: false,
  },
} as const;

const WORKOUT_PROPERTIES = {
  date: { type: 'string', description: 'The day the workout is scheduled for, as YYYY-MM-DD.' },
  name: { type: 'string', description: 'Workout name, e.g. "8x400m". Defaults to the sport and date.' },
  sport: {
    type: 'string',
    enum: ['running', 'cycling', 'swimming', 'walking', 'hiking', 'rowing', 'training', 'generic'],
    description: 'Defaults to running.',
  },
  sub_sport: {
    type: 'string',
    enum: [
      'treadmill', 'street', 'trail', 'track', 'ultra', 'road', 'mountain', 'indoor_cycling',
      'spin', 'virtual_activity', 'lap_swimming', 'open_water', 'indoor_rowing', 'indoor_walking', 'generic',
    ],
    description: 'How the sport is done. The watch picks its activity profile from this, so a treadmill session does not wait for GPS.',
  },
  notes: {
    type: 'string',
    description:
      'Description of the session. Written into the FIT file, so the watch shows it — and a FIT ' +
      'field holds about 250 characters, past which the file carries the start and drops the rest. ' +
      'Say the point of the session in that, and leave the reasoning for the context documents.',
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Free-form labels for the session, e.g. ["key"] for a week\'s key session. Carried to a ' +
      'connected calendar — on intervals.icu they are the event\'s own tags, which it filters on. ' +
      `At most ${MAX_TAGS}, ${MAX_TAG_LENGTH} characters each. Sending the field replaces the whole ` +
      'list, and an empty array clears it.',
  },
  external_id: {
    type: 'string',
    description:
      'Your own key for this workout. Creating one again with the same key updates that workout ' +
      'in place instead of adding a duplicate, which is what makes re-syncing a plan safe.',
  },
  steps: STEP_SCHEMA,
} as const;

/** Taken wherever a workout is named and ignored, because callers already hold one. */
const ON_DATE = { type: 'string', description: 'Optional and ignored; the id names it.' } as const;

const WORKOUT_ID = { type: 'string', description: 'The workout id.' } as const;

/** `"a", "b" and "c"` — kinds named in prose, from one list, so no description can drift from it. */
const nameKinds = (kinds: readonly context.ContextKind[]): string =>
  kinds
    .map((kind) => `"${kind}"`)
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');

/**
 * What each kind is for, in the schema rather than only in a reply. A client
 * reads the tool list before it decides to call anything, and "which document to
 * replace" is no help to one deciding what belongs in a document it has not read.
 */
const describeKinds = (kinds: readonly context.ContextKind[]): string =>
  kinds.map((kind) => `"${kind}": ${context.CONTEXTS[kind].purpose}`).join(' ');

const WRITABLE_CONTEXTS = nameKinds(context.WRITABLE_KINDS);

/** `get_current_plan, get_workout_zones and …` — read tools named in prose, from one list. */
const nameTools = (kinds: readonly context.ContextKind[]): string =>
  kinds
    .map((kind) => context.readToolName(kind))
    .join(', ')
    .replace(/, ([^,]*)$/, ' and $1');

/** Every context read tool: named per document, and all the same shape but the prose. */
const CONTEXT_READ_TOOLS: Record<string, context.ContextKind> = Object.fromEntries(
  context.CONTEXT_KINDS.map((kind) => [context.readToolName(kind), kind]),
);

/**
 * The parts of a read tool that are the same for all four, so the four entries
 * below are their names and nothing else. Only `name` is written out, because a
 * spread would stop it being a literal type.
 */
const readsContext = (kind: context.ContextKind) => {
  const { label, purpose, writableOverMcp } = context.CONTEXTS[kind];
  return {
    annotations: { title: `Read the athlete's ${label.toLowerCase()}`, readOnlyHint: true, openWorldHint: false },
    description:
      `${purpose} Markdown to read, not tool arguments; \`markdown: null\` means unwritten — ask, ` +
      'do not assume a default. ' +
      (writableOverMcp
        ? 'Write it with update_context once they agree.'
        : `Read-only here; edited on the dashboard or at PUT /api/context/${kind}.`),
    inputSchema: { type: 'object', properties: {} },
  };
};

/**
 * **Keep every `description` to about 50 words, and one line where it fits.** This array
 * is serialised in full on every `tools/list`, so it is context an assistant pays for
 * before it has decided to call anything.
 *
 * Say the one thing a caller cannot work out from the name and the schema, and stop.
 * Worth the words: a non-obvious order of calls, a unit or sentinel that would be misread,
 * a limit that will be hit, a constraint that protects the athlete. Not worth them: which
 * tool to call next, what a field named `date` holds, or a retelling of the annotations.
 */
export const TOOLS = [
  {
    name: 'list_workouts',
    annotations: { title: 'List planned workouts', readOnlyHint: true, openWorldHint: false },
    description:
      'List planned workouts in the retention window: 7 days back, 14 ahead. A wider from/to is ' +
      'narrowed to it rather than refused. A recorded session carries `stats`, and `comment` is ' +
      "the athlete's own note on it.",
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Earliest date to include, YYYY-MM-DD.' },
        to: { type: 'string', description: 'Latest date to include, YYYY-MM-DD.' },
      },
    },
  },
  {
    name: 'get_workout',
    annotations: { title: 'Read a planned workout', readOnlyHint: true, openWorldHint: false },
    description:
      'Fetch one planned workout, by id or by a date holding exactly one. Once the session has ' +
      'been recorded, `stats` carries the totals and `comment` the athlete\'s own note on how it ' +
      'went — read that before judging the numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The day to read, YYYY-MM-DD. Only used without an id.' },
        id: { type: 'string', description: 'The workout id. Give this or a date.' },
      },
    },
  },
  {
    name: 'create_workout',
    annotations: { title: 'Create a planned workout', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description:
      'Create a planned workout and return its id; a date may hold several. Read the athlete\'s ' +
      `context first — ${nameTools(context.CONTEXT_KINDS)} — for how they train, which days they ` +
      'train, and the zones a target is anchored to.',
    inputSchema: { type: 'object', properties: WORKOUT_PROPERTIES, required: ['date', 'steps'] },
  },
  {
    name: 'update_workout',
    annotations: { title: 'Replace a planned workout', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description:
      'Replace a workout in full, keeping its id; a changed date moves it. As with create_workout, ' +
      `read ${nameTools(context.CONTEXT_KINDS)} first.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the workout to replace.' },
        current_date: ON_DATE,
        ...WORKOUT_PROPERTIES,
      },
      required: ['id', 'date', 'steps'],
    },
  },
  {
    name: 'reschedule_workout',
    annotations: { title: 'Move a workout to another day', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Move a planned workout to another day, keeping its id and everything recorded against it. ' +
      'Use this rather than update_workout when only the day changes: a session already done ' +
      'refuses a rewritten plan, but moves.',
    inputSchema: {
      type: 'object',
      properties: {
        date: ON_DATE,
        id: WORKOUT_ID,
        to_date: { type: 'string', description: 'The day to move it to, YYYY-MM-DD.' },
      },
      required: ['id', 'to_date'],
    },
  },
  {
    name: 'delete_workout',
    annotations: { title: 'Delete a planned workout', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Delete a planned workout by id.',
    inputSchema: {
      type: 'object',
      properties: { date: ON_DATE, id: WORKOUT_ID },
      required: ['id'],
    },
  },
  {
    name: 'complete_workout',
    annotations: { title: 'Mark a workout done', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Record that a workout was done, and when. Defaults to now; pass completed_at only to log ' +
      'one after the fact, or completed: false to clear the record. The plan itself is untouched, ' +
      'and rewriting it later leaves the record standing.',
    inputSchema: {
      type: 'object',
      properties: {
        date: ON_DATE,
        id: WORKOUT_ID,
        completed_at: {
          type: 'string',
          description:
            'When it was done, as an ISO 8601 timestamp such as "2026-09-12T06:30:00Z". ' +
            'A bare YYYY-MM-DD is read as the start of that day. Defaults to now.',
        },
        completed: {
          type: 'boolean',
          description: 'Defaults to true. Pass false to clear the record instead, leaving the workout planned.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'comment_workout',
    annotations: { title: 'Comment on a workout', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Store the athlete's own note on how a session went. Their words, so ask them rather than " +
      'summarising: this is never written for them. Pushed to the session on a connected platform, ' +
      'and never read back from one. Empty clears it. Not the plan\'s `notes`, which go to the ' +
      'watch beforehand.',
    inputSchema: {
      type: 'object',
      properties: {
        date: ON_DATE,
        id: WORKOUT_ID,
        comment: {
          type: 'string',
          description:
            'How the session went, in the athlete\'s own words. At most ' +
            `${MAX_COMMENT_LENGTH} characters. Empty clears the note.`,
        },
      },
      required: ['id', 'comment'],
    },
  },
  {
    name: 'export_workout_fit',
    annotations: { title: 'Export a workout as FIT', readOnlyHint: true, openWorldHint: false },
    description:
      'Encode a planned workout as a Garmin FIT file. The whole file comes back base64 in the ' +
      'response, with the name to save it under — decode those bytes to produce it. There is no ' +
      'URL to link to.',
    inputSchema: {
      type: 'object',
      properties: { date: ON_DATE, id: WORKOUT_ID },
      required: ['id'],
    },
  },
  {
    name: 'get_workout_stats',
    annotations: { title: 'Read what was actually done', readOnlyHint: true, openWorldHint: false },
    description:
      'What the athlete actually did: session totals, one lap per segment of the recording mapped ' +
      'to the planned step it was for, and time-in-band where a step had a target. Pace is integer ' +
      'seconds per kilometre, and an unrecorded figure is null, never 0 — read `flags` first.',
    inputSchema: {
      type: 'object',
      properties: { date: ON_DATE, id: WORKOUT_ID },
      required: ['id'],
    },
  },
  { name: 'get_workout_library', ...readsContext('workout-library') },
  { name: 'get_current_plan', ...readsContext('current-plan') },
  { name: 'get_scheduling_instructions', ...readsContext('scheduling-instructions') },
  { name: 'get_workout_zones', ...readsContext('workout-zones') },
  {
    name: 'get_onboarding_instructions',
    annotations: { title: 'Read the setup interview', readOnlyHint: true, openWorldHint: false },
    description:
      'The interview that fills an empty context: what to ask the athlete about their sports, ' +
      'goals, week and zones, and how to write the three documents from the answers. Long, and ' +
      'only worth fetching when setting up or revising context — call it when asked to, or when ' +
      'a context read comes back empty.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_context',
    annotations: {
      title: "Replace one of the athlete's context documents",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Replace one context document in full — the athlete's standing brief, which outlives this " +
      'conversation. Read it first, show them what you mean to put there, and call this only once ' +
      `they have agreed. There is no partial edit; empty clears it, over ${context.MAX_CONTEXT_BYTES / 1024} KB is refused. ` +
      `Only ${WRITABLE_CONTEXTS} — the workout library is written on the dashboard instead.`,
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [...context.WRITABLE_KINDS],
          description:
            `Which document to replace, each read by a tool of its own. ` +
            `${describeKinds(context.WRITABLE_KINDS)}`,
        },
        markdown: {
          type: 'string',
          description: 'The whole document, as markdown. Empty clears it.',
        },
      },
      required: ['kind', 'markdown'],
    },
  },
  {
    name: 'list_recorded_workouts',
    annotations: { title: 'List sessions actually recorded', readOnlyHint: true, openWorldHint: true },
    description:
      'Sessions the athlete actually recorded on a platform — what they did, not what was planned ' +
      `— plus a download_url for them as one ZIP of FIT files. At most ${recordings.MAX_RANGE_DAYS} days per call and ` +
      `${recordings.MAX_RECORDINGS} sessions per archive. The link needs no credential and expires after ` +
      `${recordings.LINK_TTL_SECONDS / 3600} hours.`,
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: Object.keys(PLATFORMS),
          description: 'The platform the sessions were recorded on. Required, and it must be connected.',
        },
        from: { type: 'string', description: 'Earliest day to include, YYYY-MM-DD, in the athlete\'s own local days.' },
        to: { type: 'string', description: 'Latest day to include, YYYY-MM-DD, inclusive.' },
        sport: {
          description:
            'Keep only these sports. One sport or several; omit for everything. A session whose ' +
            'activity type we cannot place on this scale is left out when this is set.',
          oneOf: [
            { type: 'string', enum: [...SPORTS] },
            { type: 'array', items: { type: 'string', enum: [...SPORTS] } },
          ],
        },
      },
      required: ['platform', 'from', 'to'],
    },
  },
] as const;

export type ToolName = (typeof TOOLS)[number]['name'];

export class ToolError extends Error {}

const asObject = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

/** The one 404 a workout has: it is named by its id, wherever the caller thinks it sits. */
export const missing = (id: string): string => `no workout ${id}`;

const requireString = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || value === '') throw new ToolError(`${key} is required`);
  return value;
};

// For the dashboard alone: no tool result carries a URL, and docs/mcp.md says why.
const urls = (workout: Workout, baseUrl: string) => ({
  fit_url: `${baseUrl}/export/${workout.date}-${workout.id}.fit`,
  json_url: `${baseUrl}/api/workouts/${workout.date}/${workout.id}.json`,
});

/** The stored fields plus the derived totals. `stats` carries session totals only; the laps live in `get_workout_stats`. */
export function present(workout: Workout, baseUrl?: string) {
  return {
    ...workout,
    summary: describeWorkout(workout),
    planned: plannedTotals(workout.steps),
    ...(baseUrl ? urls(workout, baseUrl) : {}),
  };
}

/** What a write returns: which workout it was. Echoing the plan back is noise. */
export function presentBrief(workout: Workout, baseUrl?: string) {
  const { steps: _steps, ...rest } = workout;
  return { ...rest, ...(baseUrl ? urls(workout, baseUrl) : {}) };
}

/**
 * Only ever used to build a link a caller can follow, which `list_recorded_workouts` is
 * the one tool to return — see docs/mcp.md — because what it points at is signed rather
 * than credential-bound.
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  env: Env,
  user: User,
  origin: string,
): Promise<unknown> {
  const args = asObject(rawArgs);

  // One tool per context document, all answered the same way. See src/context.ts.
  const contextKind = CONTEXT_READ_TOOLS[name];
  if (contextKind) return await context.readContext(env, user.id, contextKind);

  switch (name) {
    case 'list_workouts': {
      const from = args.from === undefined ? undefined : parseDate(args.from, 'from');
      const to = args.to === undefined ? undefined : parseDate(args.to, 'to');
      const workouts = await db.listWorkouts(env, user.id, from, to);
      return { workouts: workouts.map((w) => present(w)) };
    }

    case 'get_workout': {
      // The one tool a date does something in: without an id it is the whole question.
      if (typeof args.id === 'string' && args.id !== '') {
        const workout = await db.getWorkout(env, user.id, args.id);
        if (!workout) throw new ToolError(missing(args.id));
        return present(workout);
      }
      const date = parseDate(requireString(args, 'date'), 'date');
      const onDate = await db.listWorkouts(env, user.id, date, date);
      if (onDate.length === 0) throw new ToolError(`no workouts on ${date}`);
      if (onDate.length > 1) {
        return {
          message: `${onDate.length} workouts on ${date}; pass an id to pick one`,
          workouts: onDate.map((w) => present(w)),
        };
      }
      return present(onDate[0]);
    }

    case 'create_workout': {
      const workout = await plan.createWorkout(env, user, parseWorkout(args));
      return presentBrief(workout);
    }

    case 'update_workout': {
      const id = requireString(args, 'id');
      const { id: _id, current_date: _currentDate, ...rest } = args;

      const workout = await plan.replaceWorkout(env, user, id, parseWorkout(rest));
      if (!workout) throw new ToolError(missing(id));
      return presentBrief(workout);
    }

    case 'reschedule_workout': {
      const id = requireString(args, 'id');
      const toDate = parseDate(requireString(args, 'to_date'), 'to_date');

      const workout = await plan.moveWorkout(env, user, id, toDate);
      if (!workout) throw new ToolError(missing(id));
      return presentBrief(workout);
    }

    case 'delete_workout': {
      const id = requireString(args, 'id');
      const deleted = await plan.deleteWorkout(env, user, id);
      if (!deleted) throw new ToolError(missing(id));
      return { deleted: true, date: deleted.date, id };
    }

    case 'complete_workout': {
      const id = requireString(args, 'id');

      let completed = true;
      if (args.completed !== undefined && args.completed !== null) {
        if (typeof args.completed !== 'boolean') throw new ToolError('completed must be true or false');
        completed = args.completed;
      }
      // Contradictory asks: guessing which was meant would silently do the other.
      if (!completed && args.completed_at !== undefined && args.completed_at !== null) {
        throw new ToolError('completed_at has no meaning alongside completed: false');
      }

      const completedAt = !completed
        ? null
        : args.completed_at === undefined || args.completed_at === null
          ? new Date().toISOString()
          : parseTimestamp(args.completed_at, 'completed_at');

      const workout = await plan.setCompleted(env, user, id, completedAt);
      if (!workout) throw new ToolError(missing(id));
      return presentBrief(workout);
    }

    case 'comment_workout': {
      const id = requireString(args, 'id');
      if (args.comment === undefined) throw new ToolError('comment is required; send an empty one to clear it');

      const workout = await plan.setComment(env, user, id, parseComment(args.comment));
      if (!workout) throw new ToolError(missing(id));
      return presentBrief(workout);
    }

    case 'export_workout_fit': {
      const id = requireString(args, 'id');
      const workout = await db.getWorkout(env, user.id, id);
      if (!workout) throw new ToolError(missing(id));
      const bytes = encodeWorkoutFit(workout);
      return {
        filename: fitDownloadName(workout),
        content_type: 'application/vnd.ant.fit',
        bytes: bytes.length,
        base64: base64Encode(bytes),
      };
    }

    case 'get_workout_stats': {
      const id = requireString(args, 'id');
      // Both, always: the note is what says why the numbers look as they do, and an
      // analysis that reads one without the other is reading half the session.
      const [stats, workout] = await Promise.all([
        db.getStats(env, user.id, id),
        db.getWorkout(env, user.id, id),
      ]);
      if (stats) return { ...stats, comment: workout?.comment ?? null };

      if (!workout) throw new ToolError(missing(id));
      throw new ToolError(
        `nothing has been recorded against ${id} yet; stats are read off the session ` +
          'once the connected platform has matched it to this workout',
      );
    }

    case 'update_context': {
      if (!context.isContextKind(args.kind)) throw new ToolError(`unknown context "${String(args.kind)}"`);
      if (!context.CONTEXTS[args.kind].writableOverMcp) {
        throw new ToolError(
          `"${args.kind}" cannot be written here; it is edited on the dashboard, ` +
            `or over the REST API at PUT /api/context/${args.kind}`,
        );
      }
      if (typeof args.markdown !== 'string') throw new ToolError('markdown is required');
      return await context.saveContext(env, user.id, args.kind, args.markdown);
    }

    case 'get_onboarding_instructions':
      return { markdown: ONBOARDING_INSTRUCTIONS };

    case 'list_recorded_workouts':
      return await recordings.list(env, user, recordings.parseQuery(args), origin);

    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}

/** Caller-visible errors get a 400; everything else is ours. */
export const isCallerError = (error: unknown): error is Error =>
  error instanceof ToolError || error instanceof WorkoutError;
