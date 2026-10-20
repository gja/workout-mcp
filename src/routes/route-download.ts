// The GPX a `plan_route` link names, opened by its signature alone. See docs/routes.md.

import type { Context, Route } from '../http';
import { CORS_HEADERS, error } from '../http';
import * as route from '../route';
import type { Router } from '../router';
import { LinkRejected } from '../signing';

/** No `withUser`, as with the recordings archive: the link is handed to whatever holds no credential. */
const downloadGpx: Route = async ({ env, url }) => {
  let file;
  try {
    file = await route.downloadGpx(env, url.searchParams.get('claims'), url.searchParams.get('signature'));
  } catch (err) {
    if (err instanceof LinkRejected) return error(err.message, 403);
    throw err;
  }
  return new Response(file.gpx, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/gpx+xml',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
};

export const routes = (app: Router<Context>): void => {
  app.get(route.DOWNLOAD_PATH, downloadGpx);
};
