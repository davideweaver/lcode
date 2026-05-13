import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import matter from 'gray-matter';
import type { Skill, SkillFrontmatter, SkillScope } from './types.js';

export interface LoadSkillsOptions {
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
  /** Sink for per-skill parse errors. Defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

/**
 * Discover skills in two layers and merge them.
 *
 * Precedence (highest first):
 *   1. `<projectRoot>/.claude/skills/<name>/SKILL.md`   — project-scope
 *   2. `~/.lcode/skills/<name>/SKILL.md`                — lcode user-scope
 *
 * On duplicate name, the higher-precedence file wins.
 * Project root is the nearest ancestor with a `.git` entry, or `cwd` if none.
 */
export async function loadSkills(
  cwd: string,
  opts: LoadSkillsOptions = {},
): Promise<Skill[]> {
  const home = opts.homeDir ?? homedir();
  const warn = opts.onWarn ?? ((m) => console.warn(`[skills] ${m}`));

  const projectRoot = (await findProjectRoot(cwd)) ?? cwd;
  const projectSkillsDir = join(projectRoot, '.claude', 'skills');
  const userSkillsDir = join(home, '.lcode', 'skills');

  const projectSkills = await scanSkillsDir(projectSkillsDir, 'project', warn);
  const userSkills = await scanSkillsDir(userSkillsDir, 'user', warn);

  // Higher-precedence (project) first; merge by name keeping first.
  const merged = new Map<string, Skill>();
  for (const s of projectSkills) if (!merged.has(s.name)) merged.set(s.name, s);
  for (const s of userSkills) if (!merged.has(s.name)) merged.set(s.name, s);

  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function scanSkillsDir(
  dir: string,
  scope: SkillScope,
  warn: (m: string) => void,
): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    const subDir = join(dir, entry);
    let info;
    try {
      info = await stat(subDir);
    } catch {
      continue;
    }
    if (!info.isDirectory()) continue;
    const source = join(subDir, 'SKILL.md');
    let raw: string;
    try {
      raw = await readFile(source, 'utf8');
    } catch {
      continue;
    }
    const skill = parseSkill(raw, source, subDir, entry, scope, warn);
    if (skill) out.push(skill);
  }
  return out;
}

function parseSkill(
  raw: string,
  source: string,
  dir: string,
  defaultName: string,
  scope: SkillScope,
  warn: (m: string) => void,
): Skill | null {
  let parsed;
  try {
    parsed = matter(raw);
  } catch (err) {
    warn(`${source}: malformed frontmatter — skipped (${err instanceof Error ? err.message : err})`);
    return null;
  }
  const fm = (parsed.data ?? {}) as SkillFrontmatter;
  const name = typeof fm.name === 'string' && fm.name.length > 0 ? fm.name : defaultName;
  return {
    name,
    scope,
    source,
    dir,
    description: typeof fm.description === 'string' ? fm.description : '',
    whenToUse: typeof fm['when-to-use'] === 'string' ? fm['when-to-use'] : undefined,
    argumentHint: typeof fm['argument-hint'] === 'string' ? fm['argument-hint'] : undefined,
    disableModelInvocation: fm['disable-model-invocation'] === true,
    userInvocable: fm['user-invocable'] !== false,
    body: parsed.content,
  };
}

/**
 * Resolve the project root by walking up from `cwd` looking for `.git`.
 * Returns the resolved cwd if no git boundary is found.
 *
 * Exported so app/cli code can use the same path that scopes
 * `~/.lcode/skills-enabled.json` entries.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let dir = resolve(cwd);
  while (true) {
    try {
      const info = await stat(join(dir, '.git'));
      if (info.isDirectory() || info.isFile()) return dir;
    } catch {
      /* not here */
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(cwd);
    dir = parent;
  }
}
