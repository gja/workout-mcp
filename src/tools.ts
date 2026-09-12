// The tool surface, shared by MCP and REST. The schemas are what an assistant
// reads before writing a workout, so they carry the examples. See docs/mcp.md.

import { base64Encode, encodeWorkoutFit, fitDownloadName } from './fit';
import { describeWorkout, plannedTotals } from './describe';
import * as db from './db';
import type { Env, User } from './db';
import * as plan from './plan';
import { PLATFORMS } from './platforms';
import * as recordings from './recordings';
import { WorkoutError, parseWorkout } from './workout';
import type { Workout } from './workout';
import { parseDate, parseTimestamp } from './units';
import { SPORTS } from './workout';

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

/** JSON Schema for a workout's steps, referenced by create and update. */
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
      notes: { type: 'string', description: 'Longer note shown on the watch.' },
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
  notes: { type: 'string', description: 'Description of the session. Written into the FIT file, so the watch shows it.' },
  external_id: {
    type: 'string',
    description:
      'Your own key for this workout. Creating one again with the same key updates that workout ' +
      'in place instead of adding a duplicate, which is what makes re-syncing a plan safe.',
  },
  steps: STEP_SCHEMA,
} as const;

/** The annotations are advisory — they shape how a client asks, not what the server allows. */
export const TOOLS = [
  {
    name: 'list_workouts',
    annotations: { title: 'List planned workouts', readOnlyHint: true, openWorldHint: false },
    description:
      'List planned workouts within the retention window (7 days back, 14 days ahead). ' +
      'Returns each workout with its date and id; pass those to export_workout_fit for the file. ' +
      'A wider from/to is narrowed to the window rather than honoured.',
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
    description: 'Fetch one planned workout by date and id. If a date has exactly one workout, the id may be omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        date: WORKOUT_PROPERTIES.date,
        id: { type: 'string', description: 'The workout id. Optional when the date holds a single workout.' },
      },
      required: ['date'],
    },
  },
  {
    name: 'create_workout',
    annotations: { title: 'Create a planned workout', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    description:
      'Create a planned workout on a date and return its id. ' +
      'A date may hold several workouts; each gets its own id.',
    inputSchema: { type: 'object', properties: WORKOUT_PROPERTIES, required: ['date', 'steps'] },
  },
  {
    name: 'update_workout',
    annotations: { title: 'Replace a planned workout', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Replace an existing workout in full. The id is kept; the date may be changed to move the workout.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the workout to replace.' },
        current_date: { type: 'string', description: 'The date the workout is currently on, YYYY-MM-DD.' },
        ...WORKOUT_PROPERTIES,
      },
      required: ['id', 'current_date', 'date', 'steps'],
    },
  },
  {
    name: 'delete_workout',
    annotations: { title: 'Delete a planned workout', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Delete a planned workout by date and id.',
    inputSchema: {
      type: 'object',
      properties: { date: WORKOUT_PROPERTIES.date, id: { type: 'string' } },
      required: ['date', 'id'],
    },
  },
  {
    name: 'complete_workout',
    annotations: { title: 'Mark a workout done', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'Record that a planned workout was actually done, and when. Defaults to now, so ' +
      'completed_at is only needed when logging a session after the fact. ' +
      'Pass completed: false to clear the record and put the workout back to merely planned. ' +
      'The plan itself is untouched, and rewriting the plan later leaves the record in place.',
    inputSchema: {
      type: 'object',
      properties: {
        date: WORKOUT_PROPERTIES.date,
        id: { type: 'string', description: 'The workout id.' },
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
      required: ['date', 'id'],
    },
  },
  {
    name: 'export_workout_fit',
    annotations: { title: 'Export a workout as FIT', readOnlyHint: true, openWorldHint: false },
    description:
      'Encode a planned workout as a Garmin FIT workout file. Returns the whole file base64-encoded ' +
      'in the response, along with the name to save it under: decode those bytes to produce the ' +
      '.fit file. There is no URL to link to.',
    inputSchema: {
      type: 'object',
      properties: { date: WORKOUT_PROPERTIES.date, id: { type: 'string' } },
      required: ['date', 'id'],
    },
  },
  {
    name: 'list_recorded_workouts',
    annotations: { title: 'List sessions actually recorded', readOnlyHint: true, openWorldHint: true },
    description:
      'List the sessions the athlete actually recorded on a connected training platform — what ' +
      'they did, not what was planned — and get a link to download those sessions as a ZIP of ' +
      'FIT files. Use this to analyse real training: call it for the range of interest, then ' +
      'fetch download_url and read the FIT files out of the archive. The link carries no ' +
      `credential, so it can be handed on, and it expires after ${recordings.LINK_TTL_SECONDS / 3600} hours. ` +
      `The range may cover at most ${recordings.MAX_RANGE_DAYS} days, and one archive holds at ` +
      `most ${recordings.MAX_RECORDINGS} sessions; the reply says how many matched but were left out. ` +
      'The archive also holds a manifest.json naming every file in it.',
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

/** Thrown for tool-level problems that are the caller's fault. */
export class ToolError extends Error {}

const asObject = (args: unknown): Record<string, unknown> =>
  typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};

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

/** The stored fields, steps and all, plus the derived summary and totals. */
export function present(workout: Workout, baseUrl?: string) {
  return {
    ...workout,
    summary: describeWorkout(workout),
    planned: plannedTotals(workout.steps),
    ...(baseUrl ? urls(workout, baseUrl) : {}),
  };
}

/** What a write returns: which workout it was. Echoing the steps back is noise. */
export function presentBrief(workout: Workout, baseUrl?: string) {
  const { steps: _steps, ...rest } = workout;
  return { ...rest, ...(baseUrl ? urls(workout, baseUrl) : {}) };
}

/**
 * `origin` is only ever used to build a link a caller can follow. Most tools
 * want nothing to do with it — see "No tool result carries a URL" in
 * docs/mcp.md — and `list_recorded_workouts` is the documented exception,
 * because what it points at is signed rather than credential-bound.
 */
export async function callTool(
  name: string,
  rawArgs: unknown,
  env: Env,
  user: User,
  origin: string,
): Promise<unknown> {
  const args = asObject(rawArgs);

  switch (name) {
    case 'list_workouts': {
      const from = args.from === undefined ? undefined : parseDate(args.from, 'from');
      const to = args.to === undefined ? undefined : parseDate(args.to, 'to');
      const workouts = await db.listWorkouts(env, user.id, from, to);
      return { workouts: workouts.map((w) => present(w)) };
    }

    case 'get_workout': {
      const date = parseDate(requireString(args, 'date'), 'date');
      if (typeof args.id === 'string' && args.id !== '') {
        const workout = await db.getWorkout(env, user.id, date, args.id);
        if (!workout) throw new ToolError(`no workout ${args.id} on ${date}`);
        return present(workout);
      }
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
      const currentDate = parseDate(requireString(args, 'current_date'), 'current_date');
      const { id: _id, current_date: _currentDate, ...rest } = args;

      const workout = await plan.replaceWorkout(env, user, currentDate, id, parseWorkout(rest));
      if (!workout) throw new ToolError(`no workout ${id} on ${currentDate}`);
      return presentBrief(workout);
    }

    case 'delete_workout': {
      const date = parseDate(requireString(args, 'date'), 'date');
      const id = requireString(args, 'id');
      if (!(await plan.deleteWorkout(env, user, date, id))) throw new ToolError(`no workout ${id} on ${date}`);
      return { deleted: true, date, id };
    }

    case 'complete_workout': {
      const date = parseDate(requireString(args, 'date'), 'date');
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

      const workout = await plan.setCompleted(env, user, date, id, completedAt);
      if (!workout) throw new ToolError(`no workout ${id} on ${date}`);
      return presentBrief(workout);
    }

    case 'export_workout_fit': {
      const date = parseDate(requireString(args, 'date'), 'date');
      const id = requireString(args, 'id');
      const workout = await db.getWorkout(env, user.id, date, id);
      if (!workout) throw new ToolError(`no workout ${id} on ${date}`);
      const bytes = encodeWorkoutFit(workout);
      return {
        filename: fitDownloadName(workout),
        content_type: 'application/vnd.ant.fit',
        bytes: bytes.length,
        base64: base64Encode(bytes),
      };
    }

    case 'list_recorded_workouts':
      return await recordings.list(env, user, recordings.parseQuery(args), origin);

    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}

/** Caller-visible errors get a 400; everything else is ours. */
export const isCallerError = (error: unknown): error is Error =>
  error instanceof ToolError || error instanceof WorkoutError;
