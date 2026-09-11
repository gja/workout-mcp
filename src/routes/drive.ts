// Only the HTTP shape; what a drive is lives in `src/drive/`.

import * as drive from '../drive';
import type { AuthedRoute, Context } from '../http';
import { error, json, withUser } from '../http';
import type { Router } from '../router';

const describeDrive: AuthedRoute = async ({ env, user }) => json(await drive.status(env, user));

/** The first copy runs straight away: a drive that fills in an hour later looks broken. */
const configureDrive: AuthedRoute = async ({ request, env, user }) => {
  const body = (await request.json().catch(() => ({}))) as { drive?: unknown };
  const pasted = typeof body.drive === 'string' ? body.drive.trim() : '';
  if (!pasted) return error('drive is required', 400);

  try {
    const found = await drive.configure(env, user, pasted);
    return json({ connected: true, drive_id: found.id, drive_name: found.name, sync: await drive.copyNow(env, user) });
  } catch (err) {
    if (err instanceof drive.DriveUnavailable) return error(err.message, 503);
    if (err instanceof drive.DriveError) return error(err.message, 400);
    throw err;
  }
};

const disconnectDrive: AuthedRoute = async ({ env, user }) =>
  (await drive.forget(env, user)) ? json({ disconnected: true }) : error('no drive is configured', 404);

const syncDrive: AuthedRoute = async ({ env, user }) => json(await drive.copyNow(env, user));

export const routes = (app: Router<Context>): void => {
  app
    .get('/api/drive', withUser(describeDrive))
    .put('/api/drive', withUser(configureDrive))
    .delete('/api/drive', withUser(disconnectDrive))
    .post('/api/drive/sync', withUser(syncDrive));
};
