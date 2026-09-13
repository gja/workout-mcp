// Human-readable rendering, shared by the dashboard and the MCP tool results.

import { METRES_PER_MILE, formatDuration, speedToPace } from './units';
import { resolveSteps } from './resolve';
import type { Duration, HrValue, PowerValue, ResolvedStep, Target } from './resolve';
import type { PlanStep, Workout } from './workout';

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
      // A faster pace is a higher speed, so the ends swap back for display.
      const fastest = target.high === null ? null : formatDuration(speedToPace(target.high, metres));
      const slowest = target.low === null ? null : formatDuration(speedToPace(target.low, metres));
      if (fastest && slowest) return `${fastest}-${slowest}${suffix}`;
      return slowest ? `faster than ${slowest}${suffix}` : `slower than ${fastest}${suffix}`;
    }
  }
}

/** One line per step, indented inside repeats. */
export function describeSteps(steps: ResolvedStep[], indent = ''): string[] {
  const lines: string[] = [];
  for (const step of steps) {
    if (step.kind === 'repeat') {
      lines.push(`${indent}${step.times}x`);
      lines.push(...describeSteps(step.steps, `${indent}  `));
      continue;
    }
    const targets = [step.target, step.secondary_target]
      .filter((target): target is Target => target !== undefined)
      .map(describeTarget)
      .filter(Boolean);
    const label = step.name ?? step.intensity;
    lines.push(`${indent}${label}: ${describeDuration(step.duration)}${targets.length ? ` @ ${targets.join(' + ')}` : ''}`);
  }
  return lines;
}

export function describeWorkout(workout: Workout): string {
  const sport = workout.sub_sport ? `${workout.sport}, ${workout.sub_sport.replace('_', ' ')}` : workout.sport;
  const tags = workout.tags?.length ? ` [${workout.tags.join(', ')}]` : '';
  return [
    `${workout.date} — ${workout.name} (${sport})${tags}`,
    ...describeSteps(resolveSteps(workout.steps), '  '),
  ].join('\n');
}

/** A floor, not an estimate: `open_steps` counts what runs until a lap press. */
export type PlannedTotals = { seconds: number; meters: number; steps: number; open_steps: number };

export function plannedTotals(steps: PlanStep[]): PlannedTotals {
  const totals: PlannedTotals = { seconds: 0, meters: 0, steps: 0, open_steps: 0 };

  const walk = (list: ResolvedStep[], multiplier: number): void => {
    for (const step of list) {
      if (step.kind === 'repeat') {
        walk(step.steps, multiplier * step.times);
        continue;
      }
      totals.steps += multiplier;
      if (step.duration.type === 'time') totals.seconds += step.duration.seconds * multiplier;
      else if (step.duration.type === 'distance') totals.meters += step.duration.meters * multiplier;
      else totals.open_steps += multiplier;
    }
  };

  walk(resolveSteps(steps), 1);
  totals.meters = Math.round(totals.meters);
  return totals;
}
