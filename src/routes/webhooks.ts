// Webhooks a training platform sends us. Outside `/api`, because the caller is
// intervals.icu authenticating itself with a shared secret rather than an athlete
// presenting one of our credentials. See "Completion arrives twice" in docs/integrations.md.

import * as auth from '../auth';
import type { Context, Route } from '../http';
import { error, json } from '../http';
import * as platforms from '../platforms';
import type { Router } from '../router';

/**
 * The events worth reading an athlete's completions back for.
 *
 * Neither is evidence on its own — both are nudges, and what actually marks a
 * workout done is the pairing, read over the API. So taking more of them costs a
 * read and risks nothing.
 *
 * `ACTIVITY_ANALYZED` is the one to rely on: it comes after intervals.icu has had
 * the chance to pair the activity with the event we pushed, and it is debounced, so
 * one upload is one delivery rather than a burst.
 *
 * `ACTIVITY_UPLOADED` fires on arrival, usually *before* that pairing exists, so on
 * its own it often marks nothing. It is taken anyway for the cases where it does:
 * an upload that arrives already paired is done sooner, and a delivery of the other
 * that never arrives — they gave up retrying, or we were mid-deploy — has a second
 * chance that is not an hour away.
 */
const NUDGES = new Set(['ACTIVITY_ANALYZED', 'ACTIVITY_UPLOADED']);

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
    if (typeof event?.type !== 'string' || !NUDGES.has(event.type)) continue;
    const athlete = event.athlete_id;
    if (typeof athlete === 'string' || typeof athlete === 'number') athletes.add(String(athlete));
  }

  let matched = 0;
  let marked = 0;
  let ignored = 0;
  try {
    for (const athlete of athletes) {
      const result = await platforms.onAccountActivity(env, 'intervals', athlete);
      matched += result.matched;
      marked += result.marked;
      ignored += result.ignored;
    }
  } catch (err) {
    // Anything but a 2xx is retried with exponential backoff, which is exactly what
    // a platform we could not read back from deserves.
    console.error('an intervals.icu webhook could not be acted on', err);
    return error('could not read the activity back', 502);
  }

  // An athlete nobody here has connected is a permanent condition — a retry would
  // never do better — so it answers 2xx having done nothing.
  //
  // `ignored`: paired with an event this app never pushed, so logged and stepped over.
  return json({ ok: true, athletes: athletes.size, matched, marked, ignored });
};

export const routes = (app: Router<Context>): void => {
  app.post('/webhooks/intervals', intervalsWebhook);
};
