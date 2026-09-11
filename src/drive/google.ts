// Google Drive as a service account: a signed JWT for a token, then folders and
// one streamed upload. Why a service account and not the athlete's own Google
// sign-in is in docs/drive.md.

import type { Env } from '../db';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

// `drive.file` would be narrower, but it only reaches files the app itself created:
// it cannot look up the athlete's drive, nor put a folder inside it. What actually
// bounds this credential is membership — see "Why a service account" in docs/drive.md.
const SCOPE = 'https://www.googleapis.com/auth/drive';

const FOLDER_TYPE = 'application/vnd.google-apps.folder';

/** An access token lives an hour; asking for less leaves room for a slow upload. */
const TOKEN_TTL_SECONDS = 3600;

/** Theirs, not ours: shown against the athlete's drive, and never allowed to fail a write. */
export class DriveError extends Error {}

export class DriveUnavailable extends Error {
  constructor() {
    super(
      'Google Drive is not configured on this server: set the GOOGLE_DRIVE_CLIENT_EMAIL ' +
        'and GOOGLE_DRIVE_PRIVATE_KEY bindings on the Worker',
    );
  }
}

const fail = (message: string): never => {
  throw new DriveError(message);
};

export const driveConfigured = (env: Env): boolean =>
  Boolean(env.GOOGLE_DRIVE_CLIENT_EMAIL && env.GOOGLE_DRIVE_PRIVATE_KEY);

/** The address an athlete has to share their drive with. */
export const serviceAccount = (env: Env): string | null => env.GOOGLE_DRIVE_CLIENT_EMAIL ?? null;

// --- Signing in as the service account --------------------------------------

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const encodeSegment = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** The key out of the JSON Google downloads: PEM PKCS#8, with `\n` often literal. */
function privateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/\\n/g, '\n').replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  } catch {
    return Promise.reject(new DriveError('GOOGLE_DRIVE_PRIVATE_KEY is not a base64 PKCS#8 key'));
  }
  return crypto.subtle
    .importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
    .catch(() => fail('GOOGLE_DRIVE_PRIVATE_KEY could not be read as an RSA private key'));
}

/** RFC 7523: the assertion *is* the credential, so there is no client secret to hold. */
async function assertion(env: Env): Promise<string> {
  if (!driveConfigured(env)) throw new DriveUnavailable();

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: env.GOOGLE_DRIVE_CLIENT_EMAIL,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };

  const signed = `${encodeSegment({ alg: 'RS256', typ: 'JWT' })}.${encodeSegment(claims)}`;
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    await privateKey(env.GOOGLE_DRIVE_PRIVATE_KEY!),
    new TextEncoder().encode(signed),
  );
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

/** A token per sync run. Caching one across runs would be a credential in a global. */
export async function accessToken(env: Env): Promise<string> {
  // Signed outside the try below, so an unreadable key is not reported as an outage,
  // and `DriveUnavailable` keeps its own type rather than being rewrapped.
  const signed = await assertion(env);

  let response: Response;
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signed,
      }),
    });
  } catch (err) {
    return fail(`could not reach Google (${(err as Error).message})`);
  }

  const body = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
  if (!response.ok || !body.access_token) {
    // Their own complaint names the cause — a clock skew, a deleted key, an unenabled API.
    return fail(`Google would not issue a token (${body.error_description ?? response.status})`);
  }
  return body.access_token;
}

// --- Talking to Drive -------------------------------------------------------

/** Shared-drive items are invisible to the v3 defaults unless every call says so. */
const SHARED_DRIVE_PARAMS = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  } catch (err) {
    return fail(`could not reach Google Drive (${(err as Error).message})`);
  }

  const body = (await response.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!response.ok) {
    const detail = body.error?.message ?? '';
    return fail(`Google Drive answered ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return body;
}

/** A shared drive id, pulled out of whatever the athlete pasted. */
export function readDriveId(pasted: string): string | null {
  const trimmed = pasted.trim();
  if (!trimmed) return null;
  // Both a shared drive and a folder inside one are `/drive/folders/<id>` in the address bar.
  const fromUrl = /\/(?:folders|drives|u\/\d+\/folders)\/([A-Za-z0-9_-]{6,})/.exec(trimmed);
  const id = fromUrl ? fromUrl[1] : trimmed;
  return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : null;
}

export type Drive = { id: string; name: string };

/** Why a folder is refused outright rather than used. See "Only a shared drive" in docs/drive.md. */
const NOT_A_SHARED_DRIVE =
  'that is a folder, not a shared drive. A service account owns whatever it uploads and has no ' +
  'storage of its own, so a folder in someone’s Drive has no quota to charge the file to. Make a ' +
  'shared drive — New › Shared drive — and paste that instead.';

/**
 * The shared drive behind an id, or a refusal saying why it is not one.
 *
 * Only `drives.get` is consulted, and a folder is not accepted as a substitute
 * even though its link looks identical: the upload would fail later on quota,
 * long after the form said yes. A subfolder of a shared drive would in fact
 * work, and is refused too — "paste the drive" is a rule an athlete can follow,
 * where "paste the drive, or a folder in one, but not a folder in your own
 * Drive" is not.
 */
export async function findDrive(token: string, driveId: string): Promise<Drive> {
  try {
    const drive = await call<{ id?: string; name?: string }>(
      token,
      `${DRIVE}/drives/${encodeURIComponent(driveId)}?fields=id,name`,
    );
    if (drive.id) return { id: drive.id, name: drive.name ?? 'Shared drive' };
    return fail(NOT_A_SHARED_DRIVE);
  } catch (err) {
    if (!(err instanceof DriveError) || !/ 40[34]\b/.test(err.message)) throw err;
  }

  // Not a drive. Ask what it actually is, so the refusal names it rather than guessing.
  const found = await call<{ mimeType?: string }>(
    token,
    `${DRIVE}/files/${encodeURIComponent(driveId)}?fields=mimeType&${new URLSearchParams(SHARED_DRIVE_PARAMS)}`,
  ).catch(() => null);

  if (!found) fail('Google Drive does not recognise that link, or it is not shared with the service account');
  return fail(found?.mimeType === FOLDER_TYPE ? NOT_A_SHARED_DRIVE : 'that link points at a file, not a shared drive');
}

/** A Drive query string literal: single quotes and backslashes have to be escaped. */
const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The folder of that name under `parentId`, created if it is not there yet. */
export async function ensureFolder(token: string, parentId: string, name: string): Promise<string> {
  const query = new URLSearchParams({
    q: `name = ${quote(name)} and ${quote(parentId)} in parents and mimeType = ${quote(FOLDER_TYPE)} and trashed = false`,
    fields: 'files(id)',
    pageSize: '1',
    ...SHARED_DRIVE_PARAMS,
  });
  const found = await call<{ files?: Array<{ id?: string }> }>(token, `${DRIVE}/files?${query}`);
  const existing = found.files?.[0]?.id;
  if (existing) return existing;

  const created = await call<{ id?: string }>(
    token,
    `${DRIVE}/files?fields=id&${new URLSearchParams(SHARED_DRIVE_PARAMS)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_TYPE, parents: [parentId] }),
    },
  );
  return created.id ?? fail(`Google Drive created no folder for “${name}”`);
}

// Random per upload: a fixed one would corrupt a recording that happened to
// contain it, and FIT is binary, so it could.
const boundary = (): string => `workouts-mcp-${crypto.randomUUID()}`;

// Well above any FIT recording — a long ultra is single-digit MB — and low
// enough that the recording plus the multipart body around it are nowhere near
// the isolate's 128 MB. An OOM is not catchable, so this has to be the guard.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export type Upload = {
  parentId: string;
  name: string;
  contentType: string;
  body: ReadableStream;
  /** What the platform said the recording weighs, when it said: refused before it is read. */
  length: number | null;
};

/**
 * Read the whole recording, refusing it the moment it passes the cap.
 *
 * Bounded as it arrives rather than from `Content-Length`, because the platform
 * may not have sent one — and a cap that only checks the header it was given is
 * no cap at all.
 */
async function readBounded(body: ReadableStream, what: string): Promise<Uint8Array[]> {
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) fail(`“${what}” is larger than ${MAX_UPLOAD_BYTES / 1e6} MB, so it is not relayed`);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size === 0) fail(`“${what}” came back empty`);
  return chunks;
}

/**
 * Relay a recording into the drive in one call, and answer with Google's file id.
 *
 * The bytes are assembled in memory rather than streamed because Google's
 * multipart endpoint wants a `Content-Length`, and a Worker cannot put one on a
 * streamed request body. They are held for the one call and written nowhere:
 * see "Nothing is kept here" in docs/drive.md.
 */
export async function uploadFile(token: string, upload: Upload): Promise<string> {
  // Before a byte is read, when the platform said: refusing early beats refusing late.
  if (upload.length !== null && upload.length > MAX_UPLOAD_BYTES) {
    fail(`that recording is ${Math.round(upload.length / 1e6)} MB, which is more than this will relay`);
  }

  const mark = boundary();
  const encoder = new TextEncoder();
  const metadata = { name: upload.name, parents: [upload.parentId] };
  const opening = encoder.encode(
    `--${mark}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${mark}\r\nContent-Type: ${upload.contentType}\r\n\r\n`,
  );
  const closing = encoder.encode(`\r\n--${mark}--\r\n`);

  // Assembled once, straight out of the chunks, so no copy of the recording outlives the next.
  const chunks = await readBounded(upload.body, upload.name);
  const parts = [opening, ...chunks, closing];
  const body = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.byteLength;
  }

  const query = new URLSearchParams({ uploadType: 'multipart', fields: 'id', ...SHARED_DRIVE_PARAMS });
  const created = await call<{ id?: string }>(token, `${UPLOAD}?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${mark}` },
    body,
  });
  return created.id ?? fail(`Google Drive accepted “${upload.name}” but named no file`);
}
