// The sessions an athlete actually recorded, and the link that hands them over
// as one ZIP of FIT files. Nothing is stored: the link carries its own query and
// is signed, the files are fetched when it is followed. See docs/recordings.md.

import type { Env, User } from '../db';
import * as platforms from '../platforms';
import type { ActivitySource, PlatformId, Recorded } from '../platforms';
import { fail, parseDate } from '../units';
import { SPORTS } from '../workout';
import type { Sport } from '../workout';
import { zipStream } from './zip';
import type { ZipEntry } from './zip';

/**
 * The widest range a single link may cover.
 *
 * Not a storage limit — nothing is stored — but a limit on one request: every
 * session in the range is a download the archive's own request has to make, and
 * a Worker gets a fixed number of those. A month plus a couple of days lets
 * "last month" be asked for by its own edges rather than by counting.
 */
export const MAX_RANGE_DAYS = 32;

/**
 * Sessions in one archive.
 *
 * One list call plus one download each, against the Worker's 50-subrequest
 * ceiling on the free plan, with the rest left as headroom. A range holding
 * more is not refused — it is answered with the oldest of them and a count of
 * what was left out, so a caller narrows the range rather than starting again.
 */
export const MAX_RECORDINGS = 40;

/** How long a signed link stays good for. Long enough to hand over, short enough to forget. */
export const LINK_TTL_SECONDS = 4 * 60 * 60;

/** Where a signed link lives: outside `/api/`, because it carries no credential of its own. */
export const DOWNLOAD_PREFIX = '/downloads/recordings';

// --- Naming ------------------------------------------------------------------

/** Drive allows almost anything in a name; a path separator is the one thing it must not be. */
export const safe = (value: string, limit: number): string =>
  value
    .replace(/[\\/\p{C}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, limit) || 'workout';

/**
 * `yyyy-mm-dd-<id>-<name>.fit`.
 *
 * The same name in the archive as in a connected drive, on purpose: the two are
 * the same file arriving by different routes, and an athlete who uses both
 * should be able to tell that without opening either.
 */
export const fileName = (recorded: Recorded): string =>
  `${recorded.date}-${safe(recorded.remote_id, 40)}-${safe(recorded.name, 80)}.fit`;

// --- The query ---------------------------------------------------------------

/** What a link is for: whose, from where, over what. Signed as it stands. */
export type Query = {
  platform: PlatformId;
  from: string;
  to: string;
  /** The sports to keep, or null for all of them. */
  sports: Sport[] | null;
};

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const parseSports = (value: unknown): Sport[] | null => {
  if (value === undefined || value === null || value === '') return null;
  const given = Array.isArray(value) ? value : String(value).split(',');

  const sports: Sport[] = [];
  for (const entry of given) {
    const sport = String(entry).trim().toLowerCase();
    if (sport === '') continue;
    if (!(SPORTS as readonly string[]).includes(sport)) {
      fail('sport', `"${sport}" is not a sport; expected one of ${SPORTS.join(', ')}`);
    }
    if (!sports.includes(sport as Sport)) sports.push(sport as Sport);
  }
  return sports.length > 0 ? sports : null;
};

/**
 * Read a query off whatever asked — tool arguments or a query string — and
 * refuse it here rather than half way through an archive.
 *
 * `platform` is required though there is only one to name. The alternative is a
 * link whose meaning changes when a second platform is connected, and a caller
 * that never had to say which sessions it meant.
 */
export function parseQuery(raw: {
  platform?: unknown;
  from?: unknown;
  to?: unknown;
  sport?: unknown;
}): Query {
  const platform = typeof raw.platform === 'string' ? raw.platform.trim() : '';
  if (platform === '') fail('platform', 'is required; the platform to read sessions from, e.g. "intervals"');
  if (!platforms.isPlatformId(platform)) {
    fail('platform', `"${platform}" is not a platform; expected one of ${Object.keys(platforms.PLATFORMS).join(', ')}`);
  }

  const from = parseDate(raw.from, 'from');
  const to = parseDate(raw.to, 'to');
  if (to < from) fail('to', `"${to}" is before from "${from}"`);

  const days = daysBetween(from, to);
  if (days > MAX_RANGE_DAYS) {
    fail('to', `${from} to ${to} is ${days} days; ask for at most ${MAX_RANGE_DAYS} at a time`);
  }

  return { platform, from, to, sports: parseSports(raw.sport) };
}

// --- Finding -----------------------------------------------------------------

/** A session, and the platform still holding the file. */
export type Found = { source: ActivitySource; recorded: Recorded };

export type Search = {
  found: Found[];
  /** Matched the query but fell outside `MAX_RECORDINGS`. */
  omitted: number;
};

const sourceFor = async (env: Env, userId: string, platform: PlatformId): Promise<ActivitySource> => {
  const sources = await platforms.activitySources(env, userId);
  const source = sources.find((candidate) => candidate.platform === platform);
  if (!source) {
    fail(
      'platform',
      `${platforms.PLATFORMS[platform].label} is not connected to this account, or its ` +
        'stored credential can no longer be read; connect it again',
    );
  }
  return source;
};

/**
 * Everything the athlete recorded in the range, filtered and capped.
 *
 * Oldest first, then by the platform's own id, because the archive resolves the
 * query a second time when the link is followed: the same query has to pick the
 * same sessions in the same order, or the listing a caller was shown is not the
 * one they download.
 */
export async function search(env: Env, userId: string, query: Query): Promise<Search> {
  const source = await sourceFor(env, userId, query.platform);
  const recorded = await source.activities(query.from, query.to);

  const matching = recorded
    .filter((session) => session.date >= query.from && session.date <= query.to)
    .filter((session) => !query.sports || (session.sport !== null && query.sports.includes(session.sport)))
    .sort((left, right) => left.date.localeCompare(right.date) || left.remote_id.localeCompare(right.remote_id));

  return {
    found: matching.slice(0, MAX_RECORDINGS).map((session) => ({ source, recorded: session })),
    omitted: Math.max(0, matching.length - MAX_RECORDINGS),
  };
}

// --- The signed link ---------------------------------------------------------

/**
 * Why the link is signed rather than stored.
 *
 * It has to work with no credential on it: the point is to hand it to something
 * that will fetch the files — an assistant, a browser, `curl` — without handing
 * over an account. A row in the database would do that too, but this project
 * keeps nothing about a session anywhere, and a table of "who asked for what,
 * when" is exactly the history it does not want. So the query travels inside
 * the link, an HMAC says it was us who wrote it, and the server remembers
 * nothing at all.
 *
 * What that costs: a link is a bearer credential for its four hours. Anyone
 * holding it can fetch that athlete's files for that range, and it cannot be
 * called back — only outlived, or broken by disconnecting the platform, which
 * takes the token the files are fetched with. Treat it like the download it is.
 */
export class LinksUnavailable extends Error {
  constructor() {
    super('download links are not configured: set the CREDENTIALS_SECRET binding on the Worker');
  }
}

export const linksConfigured = (env: Env): boolean => Boolean(env.CREDENTIALS_SECRET);

/**
 * The signing key, derived from the passphrase rather than being it.
 *
 * Domain-separated from the key `src/platforms/store.ts` derives for encrypting
 * tokens, out of the same secret: one passphrase, two keys, and neither usable
 * in the other's place even though both start life as the same bytes.
 */
const LABEL = 'workout-mcp/recording-download/v1';

async function signingKey(env: Env): Promise<CryptoKey> {
  if (!env.CREDENTIALS_SECRET) throw new LinksUnavailable();
  const material = new TextEncoder().encode(`${LABEL}\n${env.CREDENTIALS_SECRET}`);
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array | null => {
  try {
    const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

/** The signed half of a link. Short keys: it is read by machines and lives in a URL. */
type Claims = {
  /** Version, so a later shape can be told from a forgery of this one. */
  v: 1;
  /** The athlete. Signed, so it cannot be swapped for someone else's. */
  u: string;
  p: PlatformId;
  f: string;
  t: string;
  /** Sports, comma-joined, or absent for all of them. */
  s?: string;
  /** Expiry, epoch seconds. */
  x: number;
};

export type Link = { url: string; expires_at: string };

/** `<claims>.<signature>`, both base64url, which is the whole of what is stored anywhere. */
export async function signLink(
  env: Env,
  userId: string,
  query: Query,
  origin: string,
  now: Date = new Date(),
): Promise<Link> {
  const expiresAt = new Date(now.getTime() + LINK_TTL_SECONDS * 1000);
  const claims: Claims = {
    v: 1,
    u: userId,
    p: query.platform,
    f: query.from,
    t: query.to,
    ...(query.sports ? { s: query.sports.join(',') } : {}),
    x: Math.floor(expiresAt.getTime() / 1000),
  };

  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(payload));

  return {
    url: `${origin}${DOWNLOAD_PREFIX}/${payload}.${toBase64Url(new Uint8Array(signature))}.zip`,
    expires_at: expiresAt.toISOString(),
  };
}

export type Opened = { userId: string; query: Query; expiresAt: string };

/** Why a link did not open, in the words the response gives back. */
export class LinkRejected extends Error {}

/**
 * Read a link back, or say why not.
 *
 * The signature is checked before anything inside is looked at, let alone
 * trusted: every field — the athlete included — is the caller's until it holds.
 */
export async function openLink(env: Env, token: string, now: Date = new Date()): Promise<Opened> {
  const bare = token.replace(/\.zip$/, '');
  const split = bare.lastIndexOf('.');
  if (split <= 0) throw new LinkRejected('that is not a download link');

  const payload = bare.slice(0, split);
  const signature = fromBase64Url(bare.slice(split + 1));
  if (!signature) throw new LinkRejected('that is not a download link');

  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(env),
    signature,
    new TextEncoder().encode(payload),
  );
  if (!valid) throw new LinkRejected('this link has been altered, or was signed by someone else');

  const body = fromBase64Url(payload);
  if (!body) throw new LinkRejected('that is not a download link');

  let claims: Claims;
  try {
    claims = JSON.parse(new TextDecoder().decode(body)) as Claims;
  } catch {
    throw new LinkRejected('that is not a download link');
  }

  // Signed, so this is our own doing rather than an attack: a link from a
  // version that wrote a different shape, met by a version that cannot read it.
  if (claims.v !== 1 || typeof claims.u !== 'string' || typeof claims.x !== 'number') {
    throw new LinkRejected('this link was made by an older version and cannot be read');
  }
  if (claims.x * 1000 <= now.getTime()) {
    throw new LinkRejected('this link has expired; ask for a new one');
  }

  return {
    userId: claims.u,
    query: parseQuery({ platform: claims.p, from: claims.f, to: claims.t, sport: claims.s }),
    expiresAt: new Date(claims.x * 1000).toISOString(),
  };
}

// --- Listing -----------------------------------------------------------------

/** One recorded session, as a caller sees it. `file` names it inside the archive. */
export type Session = {
  platform: PlatformId;
  id: string;
  date: string;
  name: string;
  sport: Sport | null;
  activity_type: string | null;
  distance_m: number | null;
  moving_time_s: number | null;
  file: string;
};

const session = ({ source, recorded }: Found): Session => ({
  platform: source.platform,
  id: recorded.remote_id,
  date: recorded.date,
  name: recorded.name,
  sport: recorded.sport,
  activity_type: recorded.activity_type,
  distance_m: recorded.distance_m,
  moving_time_s: recorded.moving_time_s,
  file: fileName(recorded),
});

export type Listing = {
  platform: PlatformId;
  from: string;
  to: string;
  sport: Sport[] | null;
  count: number;
  /** Matched but left out of this link, because the range holds more than one archive may. */
  omitted: number;
  sessions: Session[];
  /** Null when nothing matched: there is no point signing an empty archive. */
  download_url: string | null;
  expires_at: string | null;
  note: string;
};

const note = (found: number, omitted: number): string => {
  if (found === 0) return 'No recorded sessions in that range.';
  const archive =
    `Follow download_url within ${LINK_TTL_SECONDS / 3600} hours for a ZIP of ${found} FIT ` +
    'file(s) plus a manifest.json describing them. The link needs no credential.';
  return omitted === 0
    ? archive
    : `${archive} ${omitted} more session(s) matched and were left out; ask for a narrower range to reach them.`;
};

/** What both the tool and `GET /api/recordings` answer with. */
export async function list(env: Env, user: User, query: Query, origin: string): Promise<Listing> {
  if (!linksConfigured(env)) throw new LinksUnavailable();

  const { found, omitted } = await search(env, user.id, query);
  const link = found.length > 0 ? await signLink(env, user.id, query, origin) : null;

  return {
    platform: query.platform,
    from: query.from,
    to: query.to,
    sport: query.sports,
    count: found.length,
    omitted,
    sessions: found.map(session),
    download_url: link?.url ?? null,
    expires_at: link?.expires_at ?? null,
    note: note(found.length, omitted),
  };
}

// --- The archive -------------------------------------------------------------

/** What went into the archive, written into it as `manifest.json`. */
type Manifest = {
  generated_at: string;
  platform: PlatformId;
  from: string;
  to: string;
  sport: Sport[] | null;
  files: Session[];
  /** Sessions that matched but whose file could not be fetched, and why. */
  failed: Array<{ id: string; date: string; name: string; error: string }>;
  omitted: number;
};

const asBytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value, null, 2));

/**
 * The entries, produced one at a time.
 *
 * A session whose file cannot be fetched is recorded in the manifest and
 * stepped over rather than failing the archive: some sessions have no file to
 * fetch at all — a manual entry, or one that arrived from Strava with no
 * streams to build a FIT from — and one of those must not cost an athlete the
 * other thirty. The manifest goes last, which is what lets it say so.
 */
async function* entries(found: Found[], query: Query, omitted: number): AsyncGenerator<ZipEntry> {
  const manifest: Manifest = {
    generated_at: new Date().toISOString(),
    platform: query.platform,
    from: query.from,
    to: query.to,
    sport: query.sports,
    files: [],
    failed: [],
    omitted,
  };

  for (const entry of found) {
    const { source, recorded } = entry;
    let file;
    try {
      file = await source.recording(recorded);
    } catch (err) {
      manifest.failed.push({
        id: recorded.remote_id,
        date: recorded.date,
        name: recorded.name,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    manifest.files.push(session(entry));
    yield {
      name: fileName(recorded),
      modified: new Date(`${recorded.date}T12:00:00Z`),
      body: file.body as ReadableStream<Uint8Array>,
    };
  }

  yield { name: 'manifest.json', body: asBytes(manifest) };
}

/** `yyyy-mm-dd_to_yyyy-mm-dd-intervals.zip`, so a download says what it holds. */
export const archiveName = (query: Query): string => `${query.from}_to_${query.to}-${query.platform}.zip`;

/**
 * The archive as a response, streaming.
 *
 * No `Content-Length`: the size is not known until the last file has been
 * fetched, and waiting to find out would mean holding the whole thing in memory
 * — the one thing this is built not to do.
 */
export async function archive(env: Env, userId: string, query: Query): Promise<ReadableStream<Uint8Array>> {
  const { found, omitted } = await search(env, userId, query);
  return zipStream(entries(found, query, omitted));
}
