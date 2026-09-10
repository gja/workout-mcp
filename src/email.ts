/**
 * Sending the login code.
 *
 * Cloudflare has no outbound transactional email — Email Routing is inbound
 * only, and an Email Worker may only send to addresses already verified on
 * your own account — so this goes out through an HTTP email API. Resend is the
 * default because it is one fetch call and its free tier (3k/month) is far
 * more than a personal training log needs.
 *
 * With no API key configured the code is written to the log instead, which is
 * what makes `wrangler dev` usable without signing up for anything.
 */

import type { Env } from './db';

export async function sendLoginCode(env: Env, email: string, code: string, appName: string): Promise<void> {
  const subject = `${code} is your ${appName} login code`;
  const text =
    `Your login code is ${code}\n\n` +
    `It expires in 10 minutes and can only be used once.\n` +
    `If you did not ask to sign in, ignore this email.\n`;

  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) {
    // Local development: no provider configured, so print it.
    console.log(`[login] code for ${email}: ${code}`);
    return;
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [email], subject, text }),
  });

  if (!response.ok) {
    // The body carries the provider's reason, which is worth having in the log.
    throw new Error(`email provider rejected the send (${response.status}): ${await response.text()}`);
  }
}
