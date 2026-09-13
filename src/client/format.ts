/** Turning the numbers the API returns into something worth reading. */

import type { Lap, LapTarget, Metric, PlannedTotals, RecordedSession, Workout } from './api';

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const remainder = minutes % 60;
  return remainder === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${remainder}`;
}

export const formatDistance = (meters: number): string =>
  meters >= 1000 ? `${Number((meters / 1000).toFixed(1))} km` : `${Math.round(meters)} m`;

/** "1 h 15 · 12 km". A trailing "+" means open steps, so the totals are a floor. */
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

/** The server's summary minus its first line, which is a header. */
export const stepLines = (workout: Workout): string => (workout.summary ?? '').split('\n').slice(1).join('\n');

// One per sport, not per sub-sport: eight distinct pictograms read at a glance, fifteen do not.
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

// --- What was actually recorded ------------------------------------------

/** "9:58", or "1:04:30" once it runs past the hour. Lap lengths, not planned totals. */
export function formatClock(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60) % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${pad(minutes)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

/** Seconds per kilometre as a pace an athlete reads: `4:05/km`. */
export const formatPace = (secondsPerKm: number): string => `${formatClock(secondsPerKm)}/km`;

/** The unit a metric is written in, so a band and its actual read the same way. */
const formatMetric = (metric: Metric, value: number): string => {
  switch (metric) {
    case 'pace_s_km':
      return formatPace(value);
    case 'hr':
      return `${value} bpm`;
    case 'power_w':
      return `${value} W`;
    case 'cadence':
      return `${value} spm`;
  }
};

/** "4:00-4:15/km", with the unit said once. */
export const formatBand = (target: LapTarget): string =>
  target.metric === 'pace_s_km'
    ? `${formatClock(target.low)}-${formatPace(target.high)}`
    : `${target.low}-${formatMetric(target.metric, target.high)}`;

/** What a lap actually did on the metric it was aimed at, or null where it was not recorded. */
export function lapActual(lap: Lap, metric: Metric): string | null {
  const recorded: Record<Metric, number | null> = {
    pace_s_km: lap.avg_pace_s_km,
    hr: lap.avg_hr,
    power_w: lap.avg_power_w,
    cadence: lap.avg_cadence,
  };
  const value = recorded[metric];
  return value === null ? null : formatMetric(metric, value);
}

/**
 * The headline figure for a lap that was given no target: whatever the session
 * actually measured, in the order a reader would look for it.
 */
export function lapHeadline(lap: Lap): string | null {
  if (lap.avg_pace_s_km !== null) return formatPace(lap.avg_pace_s_km);
  if (lap.avg_power_w !== null) return `${lap.avg_power_w} W`;
  return lap.avg_hr === null ? null : `${lap.avg_hr} bpm`;
}

/** How long a lap ran, by whatever it was measured in. */
export const lapLength = (lap: Lap): string =>
  [lap.distance_m === null ? null : formatDistance(lap.distance_m), lap.duration_s === null ? null : formatClock(lap.duration_s)]
    .filter(Boolean)
    .join(' · ');

/** "52 min · 10.2 km · 148 bpm" — the session in one line. */
export const sessionLine = (session: RecordedSession): string =>
  [
    session.moving_s === null ? null : formatDuration(session.moving_s),
    session.distance_m === null ? null : formatDistance(session.distance_m),
    session.avg_pace_s_km === null ? null : formatPace(session.avg_pace_s_km),
    session.avg_power_w === null ? null : `${session.avg_power_w} W`,
    session.avg_hr === null ? null : `${session.avg_hr} bpm avg`,
  ]
    .filter(Boolean)
    .join(' · ');

/** A flag as a sentence, for the few worth putting in front of an athlete. */
const FLAG_NOTES: Record<string, string> = {
  no_hr: 'no heart rate was recorded',
  hr_dropout: 'the heart rate reading dropped out',
  gps_dropout: 'GPS dropped out, so pace is unreliable',
  long_pause: 'the recording was paused for a while',
  laps_do_not_match_plan: 'the laps do not line up with the plan, so nothing is matched to a step',
  source_unreadable: 'the recording could not be read',
};

export const flagNotes = (flags: string[]): string[] => flags.map((flag) => FLAG_NOTES[flag]).filter(Boolean);
