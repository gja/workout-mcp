// The context an assistant reads before it plans: four markdown documents per
// athlete, three of which it may also write. See docs/context.md.

import WORKOUT_LIBRARY from './workout-library.md';
import type { Env } from './db';
import { zipStream } from './recordings/zip';
import type { ZipEntry } from './recordings/zip';
import { fail } from './units';

export type ContextKind = 'workout-library' | 'current-plan' | 'scheduling-instructions' | 'workout-zones';

type Definition = {
  label: string;
  /** What belongs in it. Read by an assistant and shown on the dashboard, so it is written for both. */
  purpose: string;
  /** The document served to an athlete who has not written their own, where there is one. */
  builtIn: string | null;
  /** False for the library: an assistant reads that one, the athlete writes it. */
  writableOverMcp: boolean;
};

export const CONTEXTS: Record<ContextKind, Definition> = {
  'workout-library': {
    label: 'Workout library',
    purpose:
      'The session types this athlete trains with and how each one is built — ladders, ' +
      'over-unders, threshold blocks, brick sessions. Reference for writing a session that ' +
      'looks like their training rather than a generic one.',
    builtIn: WORKOUT_LIBRARY,
    writableOverMcp: false,
  },
  'current-plan': {
    label: 'Current plan',
    purpose:
      'The block of training they are in now: the goal race and its date, the phase, the ' +
      'shape of a normal week, and what this particular week is meant to do. Read it before ' +
      'planning, so a session lands in the plan rather than beside it.',
    builtIn: null,
    writableOverMcp: true,
  },
  'scheduling-instructions': {
    label: 'Scheduling instructions',
    purpose:
      'How they want sessions placed: which days are training days, what has to fall on a ' +
      'particular one, what must never go back to back, and how much notice they want. ' +
      'Read it before choosing a date for anything.',
    builtIn: null,
    writableOverMcp: true,
  },
  'workout-zones': {
    label: 'Workout zones',
    purpose:
      'The watt, pace and heart-rate bands every target is anchored to, and the thresholds ' +
      'they are derived from. Without this, a zone name in any other document means nothing ' +
      'precise — so read it before writing a target.',
    builtIn: null,
    writableOverMcp: true,
  },
};

export const CONTEXT_KINDS = Object.keys(CONTEXTS) as ContextKind[];

/** The kinds an assistant may write, which is every kind but the library. */
export const WRITABLE_KINDS = CONTEXT_KINDS.filter((kind) => CONTEXTS[kind].writableOverMcp);

/** Generous for prose, small enough that one read stays one cheap D1 row. */
export const MAX_CONTEXT_BYTES = 100 * 1024;

/** Bytes rather than characters: the limit is on what is stored and sent, not on how it is spelled. */
const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export type ContextDocument = {
  kind: ContextKind;
  label: string;
  purpose: string;
  /** Null when the athlete has written nothing and the kind has no built-in document. */
  markdown: string | null;
  /** True once the athlete has written their own, whether or not a built-in one exists. */
  custom: boolean;
  /** True when clearing theirs leaves a document behind rather than nothing. */
  has_built_in: boolean;
  /** True when an assistant may replace it with update_context. */
  writable_over_mcp: boolean;
  /** When they last saved it, or null while it is the built-in document or unset. */
  updated_at: string | null;
};

export const isContextKind = (value: unknown): value is ContextKind =>
  typeof value === 'string' && Object.hasOwn(CONTEXTS, value);

type Stored = { markdown: string; updated_at: string };

function present(kind: ContextKind, stored: Stored | null): ContextDocument {
  const definition = CONTEXTS[kind];
  return {
    kind,
    label: definition.label,
    purpose: definition.purpose,
    markdown: stored ? stored.markdown : definition.builtIn,
    custom: stored !== null,
    has_built_in: definition.builtIn !== null,
    writable_over_mcp: definition.writableOverMcp,
    updated_at: stored ? stored.updated_at : null,
  };
}

export async function readContext(env: Env, userId: string, kind: ContextKind): Promise<ContextDocument> {
  const row = await env.DB.prepare('SELECT markdown, updated_at FROM contexts WHERE user_id = ? AND kind = ?')
    .bind(userId, kind)
    .first<Stored>();
  return present(kind, row ?? null);
}

/** One query for the lot: an assistant reading before it plans wants all of them. */
export async function readEveryContext(env: Env, userId: string): Promise<ContextDocument[]> {
  const { results } = await env.DB.prepare('SELECT kind, markdown, updated_at FROM contexts WHERE user_id = ?')
    .bind(userId)
    .all<Stored & { kind: string }>();
  const stored = new Map((results ?? []).map((row) => [row.kind, row]));
  return CONTEXT_KINDS.map((kind) => present(kind, stored.get(kind) ?? null));
}

/** Empty means "there is nothing to say here", so it clears rather than storing nothing. */
export async function saveContext(
  env: Env,
  userId: string,
  kind: ContextKind,
  markdown: unknown,
): Promise<ContextDocument> {
  if (typeof markdown !== 'string') fail('markdown', 'expected the document as a markdown string');
  const size = byteLength(markdown);
  if (size > MAX_CONTEXT_BYTES) {
    const asKb = (bytes: number) => Math.round(bytes / 1024);
    fail('markdown', `a context document may be at most ${asKb(MAX_CONTEXT_BYTES)} KB, and that one is ${asKb(size)} KB`);
  }

  const text = markdown.trim();
  if (text === '') return await clearContext(env, userId, kind);

  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO contexts (user_id, kind, markdown, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)
     ON CONFLICT (user_id, kind) DO UPDATE SET markdown = excluded.markdown, updated_at = excluded.updated_at`,
  )
    .bind(userId, kind, text, now)
    .run();
  return present(kind, { markdown: text, updated_at: now });
}

/** Forget what the athlete wrote; the built-in document takes over again, where there is one. */
export async function clearContext(env: Env, userId: string, kind: ContextKind): Promise<ContextDocument> {
  await env.DB.prepare('DELETE FROM contexts WHERE user_id = ? AND kind = ?').bind(userId, kind).run();
  return present(kind, null);
}

// --- Backup ------------------------------------------------------------------

/** The name to save the archive under, and the folder every document sits in. */
export const BACKUP_FILENAME = 'backup-context.zip';

/** What the archive holds, written into it so a backup says what it is without being unpacked. */
type Manifest = {
  exported_at: string;
  documents: Array<{
    kind: ContextKind;
    label: string;
    purpose: string;
    /** Absent for a kind with nothing in it, which is how the manifest records one. */
    file?: string;
    /** False where the file is the built-in document rather than something they wrote. */
    custom: boolean;
    updated_at: string | null;
  }>;
};

const asBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2));

/**
 * Every document with something in it, one markdown file each, plus a manifest.
 * The built-in library is included: a backup of the context an assistant reads
 * should be the context it reads, not only the half the athlete typed.
 */
async function* backupEntries(documents: ContextDocument[]): AsyncGenerator<ZipEntry> {
  const manifest: Manifest = { exported_at: new Date().toISOString(), documents: [] };

  for (const document of documents) {
    const entry = {
      kind: document.kind,
      label: document.label,
      purpose: document.purpose,
      custom: document.custom,
      updated_at: document.updated_at,
    };

    if (document.markdown === null) {
      manifest.documents.push(entry);
      continue;
    }

    const file = `${document.kind}.md`;
    manifest.documents.push({ ...entry, file });
    yield { name: file, body: new TextEncoder().encode(document.markdown) };
  }

  // Last, so it can describe what actually went in rather than what was meant to.
  yield { name: 'manifest.json', body: asBytes(manifest) };
}

export async function backupArchive(env: Env, userId: string): Promise<ReadableStream<Uint8Array>> {
  return zipStream(backupEntries(await readEveryContext(env, userId)));
}
