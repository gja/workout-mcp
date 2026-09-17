// The interview as an Agent Skill, served over MCP. See docs/mcp.md.

import { ONBOARDING } from './prompts';

/** Declared in `server/discover`, and what a client looks for before asking. */
export const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';

/** Qualified where the prompt is bare: a skill's name travels into a space holding everyone's. */
const NAME = 'workouts-mcp-onboarding-wizard';

/** The last segment of the parent directory MUST be the skill's name. */
const ROOT = `skill://${NAME}`;
const SKILL_MD = `${ROOT}/SKILL.md`;

const FRONTMATTER = { name: NAME, description: ONBOARDING.description };

/**
 * Double-quoted, so a description stays prose: a colon or a `#` in a plain YAML scalar
 * parses as something else, and a host compares the fields before it loads anything.
 */
const yaml = (fields: Record<string, string>): string =>
  Object.entries(fields)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');

/** What `resources/read` serves, byte for byte, and what the digests are taken of. */
const FILES = new Map<string, string>([
  [SKILL_MD, `---\n${yaml(FRONTMATTER)}\n---\n\n${ONBOARDING.markdown}`],
]);

export type SkillEntry = {
  uri: string;
  frontmatter: Record<string, string>;
  resources: Array<{ uri: string; digest: string; size: number }>;
};

const encoder = new TextEncoder();

async function digestOf(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

async function build(): Promise<SkillEntry[]> {
  const manifest = await Promise.all(
    Array.from(FILES, async ([uri, text]) => {
      const bytes = encoder.encode(text);
      return { uri, digest: await digestOf(bytes), size: bytes.length };
    }),
  );
  return [{ uri: SKILL_MD, frontmatter: FRONTMATTER, resources: manifest }];
}

/** Hashed once per isolate: the bytes are compiled in and cannot change under us. */
let built: Promise<SkillEntry[]> | null = null;
export const listSkills = (): Promise<SkillEntry[]> => (built ??= build());

export async function findSkill(uri: unknown): Promise<SkillEntry | undefined> {
  return (await listSkills()).find((skill) => skill.uri === uri);
}

export const listResources = () =>
  Array.from(FILES.keys(), (uri) => ({
    uri,
    name: uri.slice(uri.lastIndexOf('/') + 1),
    mimeType: 'text/markdown',
  }));

export const readResource = (uri: unknown): string | undefined =>
  typeof uri === 'string' ? FILES.get(uri) : undefined;
