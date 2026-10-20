// The GPX a `plan_route` link names, opened by its signature alone. See docs/routes.md.

import type { Context, Route } from '../http';
import { CORS_HEADERS, error } from '../http';
import * as route from '../route';
import type { Router } from '../router';
import { LinkRejected } from '../signing';

/** What the caller is told: an expiring link is never to be kept. */
const served = (cached: Response): Response => {
  const response = new Response(cached.body, cached);
  response.headers.set('Cache-Control', 'no-store');
  return response;
};

/**
 * No `withUser`, as with the recordings archive: the link is handed to whatever holds no
 * credential. Each file is kept at the edge until its link expires, so a link that leaks
 * costs the public router one route per colo rather than one per request.
 */
const downloadGpx: Route = async ({ request, env, url }) => {
  const hit = await caches.default.match(request);
  if (hit) return served(hit);

  let file;
  try {
    file = await route.downloadGpx(env, url.searchParams.get('claims'), url.searchParams.get('signature'));
  } catch (err) {
    if (err instanceof LinkRejected) return error(err.message, 403);
    throw err;
  }
  const seconds = Math.max(0, Math.floor((file.expiresAt.getTime() - Date.now()) / 1000));
  const response = new Response(file.gpx, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/gpx+xml',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': `public, s-maxage=${seconds}`,
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
  await caches.default.put(request, response.clone());
  return served(response);
};

export const routes = (app: Router<Context>): void => {
  app.get(route.DOWNLOAD_PATH, downloadGpx);
};
