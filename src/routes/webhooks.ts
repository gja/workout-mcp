// Webhooks a training platform sends us. Outside `/api`, because the caller is
// intervals.icu authenticating itself with a shared secret rather than an athlete
// presenting one of our credentials. See "Completion arrives twice" in docs/integrations.md.

import * as auth from '../auth';
import type { Context, Route } from '../http';
import { error, json } from '../http';
import * as platforms from '../platforms';
import type { Router } from '../router';

/**
 * The event that means a session is done *and* matched to a plan.
 *
 * Not `ACTIVITY_UPLOADED`: that fires on arrival, before intervals.icu has paired
 * the activity with the calendar event we pushed, and the pairing is the only thing
 * that says which workout was completed. `ACTIVITY_ANALYZED` also comes debounced,
 * so one upload is one event rather than a burst.
 */
const COMPLETED = 'ACTIVITY_ANALYZED';

type Event = { athlete_id?: unknown; type?: unknown };

const intervalsWebhook: Route = async ({ request, env }) => {
  // No secret means the endpoint is not in service. Refused rather than left open:
  // an unconfigured deployment must not accept unauthenticated pokes.
  if (!env.INTERVALS_WEBHOOK_SECRET) return error('webhooks are not configured on this server', 503);

  // Theirs to set, and compared verbatim — whatever was typed into their app page,
  // including any `Bearer ` prefix. Only checked where this deployment was given one.
  if (
    env.INTERVALS_WEBHOOK_AUTHORIZATION &&
    !(await auth.secretsMatch(request.headers.get('Authorization'), env.INTERVALS_WEBHOOK_AUTHORIZATION))
  ) {
    return error('unauthorized', 401);
  }

  const body = (await request.json().catch(() => ({}))) as { secret?: unknown; events?: unknown };
  const claimed = typeof body.secret === 'string' ? body.secret : null;
  if (!(await auth.secretsMatch(claimed, env.INTERVALS_WEBHOOK_SECRET))) return error('unauthorized', 401);

  // They batch, and a repeated athlete in one body is still one pass over their activities.
  const athletes = new Set<string>();
  for (const event of Array.isArray(body.events) ? (body.events as Event[]) : []) {
    if (event?.type !== COMPLETED) continue;
    const athlete = event.athlete_id;
    if (typeof athlete === 'string' || typeof athlete === 'number') athletes.add(String(athlete));
  }

  let matched = 0;
  let marked = 0;
  try {
    for (const athlete of athletes) {
      const result = await platforms.onAccountActivity(env, 'intervals', athlete);
      matched += result.matched;
      marked += result.marked;
    }
  } catch (err) {
    // Anything but a 2xx is retried with exponential backoff, which is exactly what
    // a platform we could not read back from deserves.
    console.error('an intervals.icu webhook could not be acted on', err);
    return error('could not read the activity back', 502);
  }

  // An athlete nobody here has connected is a permanent condition — a retry would
  // never do better — so it answers 2xx having done nothing.
  return json({ ok: true, athletes: athletes.size, matched, marked });
};

export const routes = (app: Router<Context>): void => {
  app.post('/webhooks/intervals', intervalsWebhook);
};
