import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONTEXTS, CONTEXT_KINDS, MAX_CONTEXT_BYTES, WRITABLE_KINDS } from '../src/context';
import { TOOLS } from '../src/tools';
import { resetDatabase, seedUser } from './helpers';
import { readZip } from './zip-reader';

const BASE = 'https://workouts.example';
const LIBRARY = CONTEXTS['workout-library'].builtIn;

let token: string;

beforeEach(async () => {
  await resetDatabase();
  ({ token } = await seedUser());
});

const call = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers },
  });

type Document = {
  kind: string;
  label: string;
  purpose: string;
  markdown: string | null;
  custom: boolean;
  has_built_in: boolean;
  writable_over_mcp: boolean;
  updated_at: string | null;
};

const read = async (kind: string): Promise<Document> => (await call(`/api/context/${kind}`)).json<Document>();

const write = (kind: string, markdown: string) =>
  call(`/api/context/${kind}`, { method: 'PUT', body: JSON.stringify({ markdown }) });

describe('the four documents', () => {
  it('offers a library, a plan, scheduling instructions and zones', () => {
    expect(CONTEXT_KINDS).toEqual([
      'workout-library',
      'current-plan',
      'scheduling-instructions',
      'workout-zones',
    ]);
  });

  it('reads them all in one call, each saying what belongs in it', async () => {
    const { contexts } = await (await call('/api/context')).json<{ contexts: Document[] }>();
    expect(contexts.map((document) => document.kind)).toEqual(CONTEXT_KINDS);
    for (const document of contexts) expect(document.purpose.length).toBeGreaterThan(20);
  });

  it('gives the library a built-in document and the other three nothing', async () => {
    const { contexts } = await (await call('/api/context')).json<{ contexts: Document[] }>();
    const byKind = new Map(contexts.map((document) => [document.kind, document]));

    expect(byKind.get('workout-library')).toMatchObject({ markdown: LIBRARY, has_built_in: true, custom: false });
    for (const kind of ['current-plan', 'scheduling-instructions', 'workout-zones']) {
      expect(byKind.get(kind)).toMatchObject({ markdown: null, has_built_in: false, custom: false });
    }
  });

  it('404s an unknown kind rather than inventing one', async () => {
    expect((await call('/api/context/race-nutrition')).status).toBe(404);
  });

  it('is behind the door', async () => {
    expect((await SELF.fetch(`${BASE}/api/context`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/context/current-plan`)).status).toBe(401);
  });
});

describe('writing one over REST', () => {
  it('saves and reads back, for a kind with no built-in document', async () => {
    expect((await write('current-plan', '# Base 2\n\nEight weeks out.')).status).toBe(200);

    const document = await read('current-plan');
    expect(document.markdown).toBe('# Base 2\n\nEight weeks out.');
    expect(document.custom).toBe(true);
    expect(document.updated_at).toBeTruthy();
  });

  it('clears back to nothing where there is no built-in document', async () => {
    await write('workout-zones', 'FTP 250W');
    expect((await call('/api/context/workout-zones', { method: 'DELETE' })).status).toBe(200);
    expect(await read('workout-zones')).toMatchObject({ markdown: null, custom: false });
  });

  it('clears back to the built-in library', async () => {
    await write('workout-library', '# Mine');
    await call('/api/context/workout-library', { method: 'DELETE' });
    expect(await read('workout-library')).toMatchObject({ markdown: LIBRARY, custom: false });
  });

  it('reads an empty save as a clear rather than storing nothing', async () => {
    await write('current-plan', '# Base 2');
    await write('current-plan', '   \n  ');
    expect(await read('current-plan')).toMatchObject({ markdown: null, custom: false });
  });

  it('keeps the four apart', async () => {
    await write('current-plan', '# Plan');
    await write('workout-zones', '# Zones');
    expect((await read('current-plan')).markdown).toBe('# Plan');
    expect((await read('workout-zones')).markdown).toBe('# Zones');
    expect((await read('scheduling-instructions')).markdown).toBeNull();
  });

  it('refuses a document that is not a string, naming the field', async () => {
    const response = await call('/api/context/current-plan', {
      method: 'PUT',
      body: JSON.stringify({ markdown: 42 }),
    });
    expect(response.status).toBe(400);
    expect((await response.json<{ error: string }>()).error).toContain('markdown');
  });

  it('refuses an absurd body before parsing it, rather than on the way out of the parser', async () => {
    const response = await call('/api/context/current-plan', {
      method: 'PUT',
      body: JSON.stringify({ markdown: 'x'.repeat(MAX_CONTEXT_BYTES * 9) }),
    });
    expect(response.status).toBe(413);
  });

  it('says how far over the limit a document is, without rounding the two together', async () => {
    const response = await write('current-plan', 'x'.repeat(MAX_CONTEXT_BYTES + 1));
    const { error } = await response.json<{ error: string }>();
    expect(error).toContain(`${MAX_CONTEXT_BYTES} bytes`);
    expect(error).toContain(`${MAX_CONTEXT_BYTES + 1}`);
  });

  it('refuses one past the size limit, in bytes rather than characters', async () => {
    expect((await write('current-plan', 'x'.repeat(MAX_CONTEXT_BYTES))).status).toBe(200);
    expect((await write('current-plan', 'x'.repeat(MAX_CONTEXT_BYTES + 1))).status).toBe(400);
    // Half as many characters as the limit, and three bytes each, so still too much.
    expect((await write('current-plan', '€'.repeat(MAX_CONTEXT_BYTES / 2))).status).toBe(400);
  });

  it('is one set of documents per athlete', async () => {
    await write('current-plan', '# Mine');
    const other = await seedUser('other@example.com');
    const response = await SELF.fetch(`${BASE}/api/context/current-plan`, {
      headers: { Authorization: `Bearer ${other.token}` },
    });
    expect(await response.json<Document>()).toMatchObject({ markdown: null, custom: false });
  });
});

describe('over MCP', () => {
  const rpc = async (name: string, args: unknown) => {
    const response = await SELF.fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await response.json()) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text: string }[] };
    };
  };

  it('reads every document in one call', async () => {
    const result = await rpc('get_context', {});
    const contexts = result.result?.structuredContent?.contexts as Document[];
    expect(contexts.map((document) => document.kind)).toEqual(CONTEXT_KINDS);
  });

  it('reads one by kind', async () => {
    await write('workout-zones', '# Zones\n\nThreshold 250W.');
    const result = await rpc('get_context', { kind: 'workout-zones' });
    expect(result.result?.structuredContent).toMatchObject({ markdown: '# Zones\n\nThreshold 250W.', custom: true });
  });

  it('writes the three that are the athlete\'s to dictate', async () => {
    for (const kind of WRITABLE_KINDS) {
      const result = await rpc('update_context', { kind, markdown: `# ${kind}` });
      expect(result.result?.isError, JSON.stringify(result.result)).toBeFalsy();
      expect((await read(kind)).markdown).toBe(`# ${kind}`);
    }
  });

  it('refuses to write the library, and says where it is edited', async () => {
    const result = await rpc('update_context', { kind: 'workout-library', markdown: '# Mine' });
    expect(result.result?.isError).toBe(true);
    expect(result.result?.content?.[0].text).toContain('/api/context/workout-library');
    expect((await read('workout-library')).markdown).toBe(LIBRARY);
  });

  it('refuses an unknown kind', async () => {
    const result = await rpc('update_context', { kind: 'race-nutrition', markdown: '# Gels' });
    expect(result.result?.isError).toBe(true);
  });

  it('offers exactly one read tool and one write tool for context', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names.filter((name) => name.endsWith('_context'))).toEqual(['get_context', 'update_context']);

    const read = TOOLS.find((tool) => tool.name === 'get_context');
    const update = TOOLS.find((tool) => tool.name === 'update_context');
    expect(read?.annotations.readOnlyHint).toBe(true);
    // Its own tool, so a client asks about writing the athlete's brief separately from reading it.
    expect(update?.annotations.readOnlyHint).toBe(false);
    expect(update?.inputSchema.properties.kind.enum).toEqual(WRITABLE_KINDS);
  });

  it('tells a planner to read the context first', () => {
    for (const name of ['create_workout', 'update_workout']) {
      expect(TOOLS.find((tool) => tool.name === name)?.description).toContain('get_context');
    }
  });
});

describe('the backup archive', () => {
  const backup = async () => {
    const response = await call('/api/context.zip');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/zip');
    expect(response.headers.get('Content-Disposition')).toContain('backup-context.zip');
    return readZip(new Uint8Array(await response.arrayBuffer()));
  };

  it('holds a markdown file per document that has something in it, and a manifest', async () => {
    await write('current-plan', '# Base 2');
    await write('workout-zones', '# Zones');

    const files = await backup();
    expect(files.map((file) => file.name).sort()).toEqual([
      'current-plan.md',
      'manifest.json',
      'workout-library.md',
      'workout-zones.md',
    ]);
    for (const file of files) expect(file.crcMatches, file.name).toBe(true);

    expect(files.find((file) => file.name === 'current-plan.md')?.content).toBe('# Base 2');
    // The built-in library goes in too: a backup of what an assistant reads is all of it.
    expect(files.find((file) => file.name === 'workout-library.md')?.content).toBe(LIBRARY);
  });

  it('records an unset document in the manifest rather than writing an empty file', async () => {
    await write('current-plan', '# Base 2');

    const files = await backup();
    const manifest = JSON.parse(files.find((file) => file.name === 'manifest.json')!.content) as {
      exported_at: string;
      documents: Array<{ kind: string; file?: string; custom: boolean }>;
    };

    expect(manifest.exported_at).toBeTruthy();
    expect(manifest.documents.map((document) => document.kind)).toEqual(CONTEXT_KINDS);
    expect(manifest.documents.find((document) => document.kind === 'current-plan')).toMatchObject({
      file: 'current-plan.md',
      custom: true,
    });
    // Nothing written and nothing built in, so no file — and the manifest is where that is said.
    expect(manifest.documents.find((document) => document.kind === 'scheduling-instructions')).toMatchObject({
      custom: false,
    });
    expect(manifest.documents.find((document) => document.kind === 'scheduling-instructions')?.file).toBeUndefined();
    expect(manifest.documents.find((document) => document.kind === 'workout-library')).toMatchObject({
      file: 'workout-library.md',
      custom: false,
    });
  });

  it('is behind the door', async () => {
    expect((await SELF.fetch(`${BASE}/api/context.zip`)).status).toBe(401);
  });
});
