/**
 * Human-readable rendering of a normalized workout — used by the dashboard and
 * returned alongside MCP tool results so an assistant can read back what it
 * just created without re-deriving it from the raw JSON.
 */

import { METRES_PER_MILE, formatDuration, speedToPace } from './units';
import type { Duration, HrValue, PowerValue, Step, Target, Workout } from './workout';

const hr = (v: HrValue): string => (v.unit === 'percent' ? `${v.value}% max HR` : `${v.value} bpm`);
const power = (v: PowerValue): string => (v.unit === 'percent' ? `${v.value}% FTP` : `${v.value} W`);

function describeDuration(duration: Duration): string {
  switch (duration.type) {
    case 'open':
      return 'until lap press';
    case 'time':
      return formatDuration(duration.seconds);
    case 'distance':
      return duration.meters >= 1000
        ? `${Number((duration.meters / 1000).toFixed(2))} km`
        : `${Math.round(duration.meters)} m`;
    case 'calories':
      return `${duration.calories} kcal`;
    case 'reps':
      return `${duration.reps} reps`;
    case 'hr_above':
      return `until HR above ${hr(duration.hr)}`;
    case 'hr_below':
      return `until HR below ${hr(duration.hr)}`;
    case 'power_above':
      return `until power above ${power(duration.power)}`;
    case 'power_below':
      return `until power below ${power(duration.power)}`;
  }
}

/** `140-150 bpm`, `above 140 bpm`, `below 150 bpm`. */
function range(low: string | null, high: string | null): string {
  if (low && high) return `${low}-${high}`;
  return low ? `above ${low}` : `below ${high}`;
}

function describeTarget(target: Target): string | null {
  switch (target.type) {
    case 'open':
      return null;
    case 'zone':
      return `${target.metric.replace('_', ' ')} zone ${target.zone}`;
    case 'heart_rate':
      return range(target.low && hr(target.low), target.high && hr(target.high));
    case 'power':
      return range(target.low && power(target.low), target.high && power(target.high));
    case 'cadence':
      return `${range(target.low?.toString() ?? null, target.high?.toString() ?? null)} rpm`;
    case 'speed': {
      const metres = target.unit === 'km' ? 1000 : METRES_PER_MILE;
      const suffix = `/${target.unit}`;
      // A faster pace is a higher speed, so the ends swap back for display: the
      // floor on speed is the slowest pace allowed, and vice versa.
      const fastest = target.high === null ? null : formatDuration(speedToPace(target.high, metres));
      const slowest = target.low === null ? null : formatDuration(speedToPace(target.low, metres));
      if (fastest && slowest) return `${fastest}-${slowest}${suffix}`;
      return slowest ? `faster than ${slowest}${suffix}` : `slower than ${fastest}${suffix}`;
    }
  }
}

/** One line per step, indented inside repeats. */
export function describeSteps(steps: Step[], indent = ''): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.kind === 'repeat') {
      lines.push(`${indent}${step.times}x`);
      lines.push(...describeSteps(step.steps, `${indent}  `));
      continue;
    }
    const target = describeTarget(step.target);
    const label = step.name ?? step.intensity;
    lines.push(`${indent}${label}: ${describeDuration(step.duration)}${target ? ` @ ${target}` : ''}`);
  }
  return lines;
}

export function describeWorkout(workout: Workout): string {
  return [`${workout.date} — ${workout.name} (${workout.sport})`, ...describeSteps(workout.steps, '  ')].join('\n');
}
