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

/**
 * One emoji per sport, for the calendar.
 *
 * A glance at the month should say what kind of week it is without reading a
 * single workout name, and a sport is the coarsest useful distinction. The
 * sub-sport is left out deliberately: a treadmill run is still a run, and
 * fifteen near-identical pictograms would say less than eight distinct ones.
 */
const SPORT_ICONS: Record<string, string> = {
  running: '\u{1F3C3}',
  cycling: '\u{1F6B4}',
  swimming: '\u{1F3CA}',
  walking: '\u{1F6B6}',
  hiking: '\u{1F97E}',
  rowing: '\u{1F6A3}',
  training: '\u{1F3CB}\u{FE0F}',
  generic: '\u{1F3C5}',
};

/** The sport's emoji, falling back to the generic one for anything unknown. */
export const sportIcon = (sport: string): string => SPORT_ICONS[sport] ?? SPORT_ICONS.generic;

/** "Fri, 12 Sep, 06:30" — when a session was done, in the athlete's own timezone. */
export const formatCompleted = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
