// A note pinned to a day or a span of days. Shape is checked here. See docs/workouts.md#notes-on-the-calendar.

import { fail, parseDate } from './units';

/** Bounds the overlap read as well as the note: see docs/database.md#notes-and-overlaps. */
export const MAX_NOTE_DAYS = 31;
export const MAX_NOTE_LENGTH = 500;

export type NoteInput = { date: string; end_date: string; text: string };

export type Note = NoteInput & { id: string; updated_at: string };

const NOTE_KEYS = new Set(['date', 'end_date', 'text']);

/** Inclusive, so a single-day note is one day long. */
export const spanDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

export function parseNote(value: unknown): NoteInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('', `expected a note object, got ${typeof value}`);
  }
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !NOTE_KEYS.has(key));
  if (unknown.length > 0) {
    fail('', `unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')}; allowed: ${[...NOTE_KEYS].sort().join(', ')}`);
  }

  const date = parseDate(raw.date, 'date');
  const endDate = raw.end_date === undefined || raw.end_date === null ? date : parseDate(raw.end_date, 'end_date');
  if (endDate < date) fail('end_date', `${endDate} is before date ${date}`);
  const days = spanDays(date, endDate);
  if (days > MAX_NOTE_DAYS) fail('end_date', `a note may cover at most ${MAX_NOTE_DAYS} days, and this is ${days}`);

  if (typeof raw.text !== 'string') fail('text', `expected a string, got ${typeof raw.text}`);
  const text = (raw.text as string).trim();
  if (text === '') fail('text', 'a note needs some text');
  if (text.length > MAX_NOTE_LENGTH) fail('text', `must be at most ${MAX_NOTE_LENGTH} characters`);

  return { date, end_date: endDate, text };
}
