// Recorded sessions: the listing, behind the door, and the signed archive link,
// which is deliberately not. See docs/recordings.md.

import type { AuthedRoute, Context, Route } from '../http';
import { CORS_HEADERS, error, json, withUser } from '../http';
import * as recordings from '../recordings';
import type { Router } from '../router';

/** `GET /api/recordings?platform=&from=&to=&sport=` — what is there, and the link to it. */
const listRecordings: AuthedRoute = async ({ url, env, user }) => {
  const query = recordings.parseQuery({
    platform: url.searchParams.get('platform'),
    from: url.searchParams.get('from'),
    to: url.searchParams.get('to'),
    // Repeated or comma-joined, whichever the caller finds easier.
    sport: url.searchParams.getAll('sport'),
  });
  try {
    return json(await recordings.list(env, user, query, url.origin));
  } catch (err) {
    // A deployment with no passphrase cannot sign a link, which is the
    // deployment's problem and not the caller's, so it is a 503 rather than a 400.
    if (err instanceof recordings.LinksUnavailable) return error(err.message, 503);
    throw err;
  }
};

/**
 * The archive, opened by its signature alone.
 *
 * No `withUser`: the whole point of the link is that it can be handed to
 * something holding no credential. What stands in for one is the HMAC — which
 * names the athlete, the platform and the range, and expires — plus the
 * athlete's platform token still being readable, without which there is nothing
 * to fetch. `/webhooks/intervals` is outside the door for the same kind of
 * reason, and docs/api.md lists both.
 */
const downloadArchive: Route = async ({ env, url }) => {
  let opened;
  try {
    opened = await recordings.openLink(env, url.searchParams.get('claims'), url.searchParams.get('signature'));
  } catch (err) {
    if (err instanceof recordings.LinkRejected) return error(err.message, 403);
    throw err;
  }

  const body = await recordings.archive(env, opened.userId, opened.query);

  return new Response(body, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${recordings.archiveName(opened.query)}"`,
      // A link that expires must not be kept, and must never be indexed.
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
};

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/recordings', withUser(listRecordings))
    .get(recordings.DOWNLOAD_PATH, downloadArchive);
};
