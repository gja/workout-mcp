/**
 * The tool surface, shared by MCP and the REST API so both behave identically.
 *
 * The step schema below is the contract an assistant reads before writing a
 * workout, so it carries the examples rather than leaving them to prose.
 */

import { encodeWorkoutFit, fitFilename } from './fit';
import { describeWorkout } from './describe';
import * as db from './db';
import type { Env, User } from './db';
import { WorkoutError, normalizeWorkout } from './workout';
import type { Workout } from './workout';
import { parseDate } from './units';

const RANGE_DOC =
  'A range as [floor, ceiling]; either end may be "-" to leave it open, ' +
  'so [140, "-"] means above 140 and ["-", 150] means below 150. ' +
  'A single value sets both ends.';

const PACE_RANGE_DOC =
  'A pace range as "mm:ss". The first entry is the floor on effort and the second the ceiling, ' +
  'and since a lower pace number is faster that reads as ["6:30", "-"] = faster than 6:30 and ' +
  '["-", "8:00"] = slower than 8:00. A two-sided band such as ["4:00", "4:15"] means the same ' +
  'either way round. A single value sets both ends.';

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
    '(a duration plus an optional target) or repeats a group of steps. ' +
    'Give a step at most one duration and at most one target; a step with no ' +
    'duration runs until the lap button is pressed. Example: ' +
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
      goal_yards: { type: 'number', description: 'Swim/run for this distance in yards.' },
      goal_calories: { type: 'number', description: 'Run until this many calories are burned.' },
      goal_reps: { type: 'number', description: 'Strength: perform this many repetitions.' },
      until_hr_above: { type: ['number', 'string'], description: 'Run until HR rises above this (bpm, or "85%").' },
      until_hr_below: { type: ['number', 'string'], description: 'Run until HR drops below this (bpm, or "70%").' },
      until_watts_above: { type: ['number', 'string'], description: 'Run until power rises above this (watts, or "95%" of FTP).' },
      until_watts_below: { type: ['number', 'string'], description: 'Run until power drops below this (watts, or "60%" of FTP).' },

      target_pace_km: range('Target pace per kilometre.', PACE_RANGE_DOC),
      target_pace_miles: range('Target pace per mile.', PACE_RANGE_DOC),
      target_heart_rate: range('Target heart rate in bpm, or "85%" for a percentage of max HR.'),
      target_watts: range('Target power in watts, or "95%" for a percentage of FTP.'),
      target_cadence: range('Target cadence in rpm (or steps per minute).'),
      target_zone: { type: 'number', description: 'Heart-rate zone 1-5, as configured on the watch.' },
      target_hr_zone: { type: 'number', description: 'Heart-rate zone 1-5.' },
      target_pace_zone: { type: 'number', description: 'Pace/speed zone 1-10.' },
      target_power_zone: { type: 'number', description: 'Power zone 1-7.' },
      target_cadence_zone: { type: 'number', description: 'Cadence zone 1-10.' },

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
  notes: { type: 'string', description: 'Free-form description of the session.' },
  steps: STEP_SCHEMA,
} as const;

export const TOOLS = [
  {
    name: 'list_workouts',
    description:
      'List planned workouts within the retention window (7 days back, 14 days ahead). ' +
      'Returns each workout with its date, id and download URL.',
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
    description:
      'Create a planned workout on a date and return its id and FIT download URL. ' +
      'A date may hold several workouts; each gets its own id.',
    inputSchema: { type: 'object', properties: WORKOUT_PROPERTIES, required: ['date', 'steps'] },
  },
  {
    name: 'update_workout',
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
    description: 'Delete a planned workout by date and id.',
    inputSchema: {
      type: 'object',
      properties: { date: WORKOUT_PROPERTIES.date, id: { type: 'string' } },
      required: ['date', 'id'],
    },
  },
  {
    name: 'export_workout_fit',
    description:
      'Encode a planned workout as a Garmin FIT workout file. Returns the file base64-encoded ' +
      'plus a URL that serves the same bytes to any client holding the API token.',
    inputSchema: {
      type: 'object',
      properties: { date: WORKOUT_PROPERTIES.date, id: { type: 'string' } },
      required: ['date', 'id'],
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

/** The public shape of a workout: the stored fields plus derived URLs and prose. */
export function present(workout: Workout, baseUrl: string) {
  return {
    ...workout,
    summary: describeWorkout(workout),
    fit_url: `${baseUrl}/export/${workout.date}-${workout.id}.fit`,
    json_url: `${baseUrl}/api/workouts/${workout.date}/${workout.id}.json`,
  };
}

export async function callTool(
  name: string,
  rawArgs: unknown,
  env: Env,
  user: User,
  baseUrl: string,
): Promise<unknown> {
  const args = asObject(rawArgs);

  switch (name) {
    case 'list_workouts': {
      const from = args.from === undefined ? undefined : parseDate(args.from, 'from');
      const to = args.to === undefined ? undefined : parseDate(args.to, 'to');
      const workouts = await db.listWorkouts(env, user.id, from, to);
      return { workouts: workouts.map((w) => present(w, baseUrl)) };
    }

    case 'get_workout': {
      const date = parseDate(requireString(args, 'date'), 'date');
      if (typeof args.id === 'string' && args.id !== '') {
        const workout = await db.getWorkout(env, user.id, date, args.id);
        if (!workout) throw new ToolError(`no workout ${args.id} on ${date}`);
        return present(workout, baseUrl);
      }
      const onDate = await db.listWorkouts(env, user.id, date, date);
      if (onDate.length === 0) throw new ToolError(`no workouts on ${date}`);
      if (onDate.length > 1) {
        return {
          message: `${onDate.length} workouts on ${date}; pass an id to pick one`,
          workouts: onDate.map((w) => present(w, baseUrl)),
        };
      }
      return present(onDate[0], baseUrl);
    }

    case 'create_workout': {
      const workout = await db.putWorkout(env, user.id, normalizeWorkout(args));
      return present(workout, baseUrl);
    }

    case 'update_workout': {
      const id = requireString(args, 'id');
      const currentDate = parseDate(requireString(args, 'current_date'), 'current_date');
      const existing = await db.getWorkout(env, user.id, currentDate, id);
      if (!existing) throw new ToolError(`no workout ${id} on ${currentDate}`);

      const { id: _id, current_date: _currentDate, ...rest } = args;
      const input = normalizeWorkout(rest);
      // A moved workout keeps its id, so the old row has to go first.
      if (input.date !== currentDate) await db.deleteWorkout(env, user.id, currentDate, id);
      return present(await db.putWorkout(env, user.id, input, id), baseUrl);
    }

    case 'delete_workout': {
      const date = parseDate(requireString(args, 'date'), 'date');
      const id = requireString(args, 'id');
      if (!(await db.deleteWorkout(env, user.id, date, id))) throw new ToolError(`no workout ${id} on ${date}`);
      return { deleted: true, date, id };
    }

    case 'export_workout_fit': {
      const date = parseDate(requireString(args, 'date'), 'date');
      const id = requireString(args, 'id');
      const workout = await db.getWorkout(env, user.id, date, id);
      if (!workout) throw new ToolError(`no workout ${id} on ${date}`);
      const bytes = encodeWorkoutFit(workout);
      return {
        filename: fitFilename(workout),
        content_type: 'application/vnd.ant.fit',
        bytes: bytes.length,
        base64: base64Encode(bytes),
        fit_url: `${baseUrl}/export/${workout.date}-${workout.id}.fit`,
      };
    }

    default:
      throw new ToolError(`unknown tool "${name}"`);
  }
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Caller-visible errors get a 400; everything else is ours. */
export const isCallerError = (error: unknown): error is Error =>
  error instanceof ToolError || error instanceof WorkoutError;
