import { SELF, env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/db';
import { DRAFT_MODEL, quickAddEnabled } from '../src/quick-add';
import { resetDatabase, seedUser } from './helpers';

const BASE = 'https://workouts.example';

let token: string;

beforeEach(async () => {
  await resetDatabase();
  await env.INTERVALS.fetch('https://intervals.icu/__control/reset');
  ({ token } = await seedUser());
});

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

const modelReplies = (aiReply: string) =>
  env.INTERVALS.fetch('https://intervals.icu/__control/setup', { method: 'POST', body: JSON.stringify({ aiReply }) });

type Call = { model: string; inputs: { messages: { role: string; content: string }[] } };
const modelCalls = async (): Promise<Call[]> =>
  (await (await env.INTERVALS.fetch('https://intervals.icu/__control/ai')).json<{ calls: Call[] }>()).calls;

const quickAdd = (body: unknown) => call('/api/quick-add', { method: 'POST', body: JSON.stringify(body) });

const STRIDES = {
  name: 'Easy run with strides',
  sport: 'running',
  notes: '',
  steps: [
    { name: 'Easy', intensity: 'active', goal_s: 1500, target_hr_zone: 2 },
    { repeat: 6, steps: [{ name: 'Stride', goal_s: 20 }, { name: 'Walk', intensity: 'recovery', goal_s: 120 }] },
  ],
};

describe('POST /api/quick-add', () => {
  it('drafts a workout on the day asked for, without saving it', async () => {
    await modelReplies(`Here you go:\n\`\`\`json\n${JSON.stringify({ ...STRIDES, date: '1999-01-01' })}\n\`\`\``);

    const response = await quickAdd({ date: '2026-10-14', description: 'easy 25 min, then strides 20s on 2 min off' });
    expect(response.status).toBe(200);
    const { workout, summary } = await response.json<{
      workout: { date: string; name: string; steps: unknown[] };
      summary: string;
    }>();
    expect(summary.split('\n')[0]).toBe('2026-10-14 — Easy run with strides (running)');
    expect(workout.date).toBe('2026-10-14');
    expect(workout.name).toBe('Easy run with strides');
    expect(workout.steps).toHaveLength(2);

    const listed = await (await call('/api/workouts')).json<{ workouts: unknown[] }>();
    expect(listed.workouts).toHaveLength(0);
  });

  it('gives the model the athlete zones and the description, and nothing else of theirs', async () => {
    await call('/api/context/workout-zones', { method: 'PUT', body: JSON.stringify({ markdown: 'Z2: 140-152 bpm' }) });
    await modelReplies(JSON.stringify(STRIDES));

    await quickAdd({ date: '2026-10-14', description: 'easy 25 min' });

    const [made] = await modelCalls();
    expect(made.model).toBe(DRAFT_MODEL);
    expect(made.inputs.messages[0].content).toContain('Z2: 140-152 bpm');
    expect(made.inputs.messages[1]).toEqual({ role: 'user', content: 'easy 25 min' });
  });

  it('answers 422 naming the field when the draft does not validate, with what the model said', async () => {
    const reply = JSON.stringify({ ...STRIDES, steps: [{ name: 'Easy', goal_s: 'soon' }] });
    await modelReplies(reply);

    const response = await quickAdd({ date: '2026-10-14', description: 'easy run' });
    expect(response.status).toBe(422);
    const body = await response.json<{ error: string; reply: string }>();
    expect(body.error).toMatch(/^steps\[0\]\.goal_s/);
    expect(body.reply).toBe(reply);
  });

  it('answers 422 when the model gives no JSON at all', async () => {
    await modelReplies('Sorry, I cannot help with that.');
    const response = await quickAdd({ date: '2026-10-14', description: 'easy run' });
    expect(response.status).toBe(422);
  });

  it('refuses a missing description or a bad date before calling the model', async () => {
    expect((await quickAdd({ date: '2026-10-14', description: ' ' })).status).toBe(400);
    expect((await quickAdd({ date: '2026-02-31', description: 'easy run' })).status).toBe(400);
    expect(await modelCalls()).toHaveLength(0);
  });

  it('is advertised on /api/me', async () => {
    const me = await (await call('/api/me')).json<{ quick_add: boolean }>();
    expect(me.quick_add).toBe(true);
  });
});

describe('switching quick add off', () => {
  it('is off when QUICK_ADD is "off" or there is no AI binding', () => {
    expect(quickAddEnabled({ ...env, QUICK_ADD: 'off' } as Env)).toBe(false);
    expect(quickAddEnabled({ ...env, AI: undefined } as Env)).toBe(false);
    expect(quickAddEnabled(env as Env)).toBe(true);
  });
});
