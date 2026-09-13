// The dashboard's own formatting. Plain functions, so they are asserted directly
// rather than through a rendered card.

import { describe, expect, it } from 'vitest';
import type { Lap } from '../src/client/api';
import {
  flagNotes,
  formatBand,
  formatClock,
  formatPace,
  lapActual,
  lapHeadline,
  lapLength,
  sessionLine,
} from '../src/client/format';

const lap = (fields: Partial<Lap> = {}): Lap => ({
  index: 1,
  role: 'work',
  rep_number: null,
  planned_step_index: 1,
  planned_step_name: 'Threshold',
  match_confidence: 'high',
  duration_s: 240,
  moving_s: 240,
  distance_m: null,
  avg_hr: null,
  max_hr: null,
  min_hr: null,
  avg_pace_s_km: null,
  avg_cadence: null,
  avg_power_w: null,
  target: null,
  flags: [],
  ...fields,
});

describe('reading a recorded lap', () => {
  it('writes a clock the way a watch does', () => {
    expect(formatClock(245)).toBe('4:05');
    expect(formatClock(59)).toBe('0:59');
    expect(formatClock(600)).toBe('10:00');
    expect(formatClock(3870)).toBe('1:04:30');
    expect(formatPace(245)).toBe('4:05/km');
  });

  it('says a band once, in the unit it was written in', () => {
    expect(formatBand({ metric: 'pace_s_km', low: 240, high: 255, pct_time_in_band: 1, pct_time_above: 0, pct_time_below: 0 }))
      .toBe('4:00-4:15/km');
    expect(formatBand({ metric: 'hr', low: 120, high: 140, pct_time_in_band: 1, pct_time_above: 0, pct_time_below: 0 }))
      .toBe('120-140 bpm');
    expect(formatBand({ metric: 'power_w', low: 180, high: 200, pct_time_in_band: 1, pct_time_above: 0, pct_time_below: 0 }))
      .toBe('180-200 W');
  });

  it('answers a target on the metric the target was set in', () => {
    expect(lapActual(lap({ avg_pace_s_km: 245, avg_hr: 162 }), 'pace_s_km')).toBe('4:05/km');
    expect(lapActual(lap({ avg_pace_s_km: 245, avg_hr: 162 }), 'hr')).toBe('162 bpm');
    // Not recorded is not zero, and not a dash invented here either.
    expect(lapActual(lap({ avg_pace_s_km: 245 }), 'power_w')).toBeNull();
  });

  it('falls back to whatever the lap did measure when it had no target', () => {
    expect(lapHeadline(lap({ avg_pace_s_km: 245, avg_hr: 162 }))).toBe('4:05/km');
    expect(lapHeadline(lap({ avg_power_w: 210, avg_hr: 162 }))).toBe('210 W');
    expect(lapHeadline(lap({ avg_hr: 162 }))).toBe('162 bpm');
    expect(lapHeadline(lap())).toBeNull();
  });

  it('says how long a lap ran, by whatever it was measured in', () => {
    expect(lapLength(lap({ distance_m: 400, duration_s: 98 }))).toBe('400 m · 1:38');
    expect(lapLength(lap({ duration_s: 240 }))).toBe('4:00');
  });
});

describe('reading a recorded session', () => {
  it('puts the totals on one line, leaving out what was not recorded', () => {
    expect(
      sessionLine({
        sport: 'running',
        indoor: false,
        elapsed_s: 3700,
        moving_s: 3600,
        distance_m: 12000,
        avg_hr: 148,
        max_hr: 171,
        avg_pace_s_km: 300,
        avg_power_w: null,
        avg_cadence: 168,
      }),
    ).toBe('1 h · 12 km · 5:00/km · 148 bpm avg');
  });

  it('turns the flags worth saying into sentences, and drops the rest', () => {
    expect(flagNotes(['no_hr', 'autopause_active'])).toEqual(['no heart rate was recorded']);
  });
});
