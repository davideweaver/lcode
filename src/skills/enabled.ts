import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface EnabledOptions {
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
  /** Sink for parse errors. Defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

interface SkillsEnabledFile {
  [projectRoot: string]: { enabled?: string[] };
}

/**
 * Path to the persistent skills-enabled file. Lives at
 * `~/.lcode/skills-enabled.json` so per-project enable lists are user-scope
 * and survive across the project tree without polluting it. Keyed by
 * absolute project path so multiple projects can coexist in one file.
 */
export function enabledFilePath(homeDir: string = homedir()): string {
  return join(homeDir, '.lcode', 'skills-enabled.json');
}

/**
 * Read the persisted enabled set for `projectRoot`. Returns an empty set
 * if the file is missing, malformed, or has no entry for this project —
 * the user can always re-enable via the /skills picker.
 */
export async function loadEnabled(
  projectRoot: string,
  opts: EnabledOptions = {},
): Promise<Set<string>> {
  const home = opts.homeDir ?? homedir();
  const warn = opts.onWarn ?? ((m) => console.warn(`[skills] ${m}`));
  const path = enabledFilePath(home);
  const file = await readFileSafe(path, warn);
  if (!file) return new Set();
  const entry = file[resolve(projectRoot)];
  const list = entry?.enabled;
  if (!Array.isArray(list)) return new Set();
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item === 'string' && item.length > 0) out.add(item);
  }
  return out;
}

/**
 * Add or remove `name` from the enabled set for `projectRoot` and persist
 * atomically. Other projects' entries are preserved untouched. Returns the
 * new enabled set for this project.
 */
export async function setEnabled(
  projectRoot: string,
  name: string,
  enabled: boolean,
  opts: EnabledOptions = {},
): Promise<Set<string>> {
  const home = opts.homeDir ?? homedir();
  const path = enabledFilePath(home);
  const key = resolve(projectRoot);
  const file = (await readFileSafe(path, opts.onWarn ?? (() => {}))) ?? {};
  const existing = new Set<string>();
  const list = file[key]?.enabled;
  if (Array.isArray(list)) {
    for (const item of list) {
      if (typeof item === 'string' && item.length > 0) existing.add(item);
    }
  }
  if (enabled) {
    existing.add(name);
  } else {
    existing.delete(name);
  }
  if (existing.size === 0) {
    delete file[key];
  } else {
    file[key] = { enabled: [...existing].sort() };
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(file, null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
  return existing;
}

async function readFileSafe(
  path: string,
  warn: (m: string) => void,
): Promise<SkillsEnabledFile | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`${path}: invalid JSON — ignoring (${err instanceof Error ? err.message : err})`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`${path}: expected object keyed by project path — ignoring`);
    return null;
  }
  return parsed as SkillsEnabledFile;
}
