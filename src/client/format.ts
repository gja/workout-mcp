/** Turning the numbers the API returns into something worth reading. */

import type { PlannedTotals, Workout } from './api';

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const remainder = minutes % 60;
  return remainder === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${remainder}`;
}

export const formatDistance = (meters: number): string =>
  meters >= 1000 ? `${Number((meters / 1000).toFixed(1))} km` : `${Math.round(meters)} m`;

/**
 * "45 min", "10 km", "1 h 15 · 12 km".
 *
 * A trailing "+" means the session also has steps that run until a lap press,
 * so the totals are a floor rather than the whole thing.
 */
export function plannedSummary(planned: PlannedTotals | undefined): string {
  if (!planned) return '';

  const parts: string[] = [];
  if (planned.seconds) parts.push(formatDuration(planned.seconds));
  if (planned.meters) parts.push(formatDistance(planned.meters));

  if (parts.length === 0) return planned.open_steps ? 'open ended' : '';
  return parts.join(' · ') + (planned.open_steps ? '+' : '');
}

/** "running, treadmill" — the sub-sport spelled out when there is one. */
export const formatSport = (workout: Workout): string =>
  workout.sub_sport ? `${workout.sport}, ${workout.sub_sport.replace(/_/g, ' ')}` : workout.sport;

/** The step lines out of the server's summary, whose first line is a header. */
export const stepLines = (workout: Workout): string => (workout.summary ?? '').split('\n').slice(1).join('\n');
