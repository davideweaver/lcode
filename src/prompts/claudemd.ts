import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export type ClaudeMdSource = 'user' | 'project' | 'directory';

export interface ClaudeMdFile {
  /** Absolute path to the file on disk. */
  path: string;
  source: ClaudeMdSource;
  /** Final content with @imports expanded. */
  content: string;
}

const MAX_IMPORT_DEPTH = 5;

export interface LoadOptions {
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
}

/**
 * Discover and load CLAUDE.md files in the same shape Claude Code uses:
 *
 *   1. `~/.claude/CLAUDE.md` (user-level — applies to everything)
 *   2. The project root's `CLAUDE.md` (project-level — checked into the repo)
 *   3. Each ancestor `CLAUDE.md` between project root and cwd (more specific
 *      directories override more general ones)
 *
 * The project root is determined by walking up from cwd until we find a
 * `.git` entry; if none is found, we fall back to cwd itself.
 *
 * `@path/to/file.md` references inside any loaded file are expanded inline
 * up to MAX_IMPORT_DEPTH levels deep.
 */
export async function loadClaudeMdFiles(
  cwd: string,
  opts: LoadOptions = {},
): Promise<ClaudeMdFile[]> {
  const home = opts.homeDir ?? homedir();
  const out: ClaudeMdFile[] = [];

  // 1. User-level
  const userPath = join(home, '.claude', 'CLAUDE.md');
  const userRaw = await tryRead(userPath);
  if (userRaw !== null) {
    out.push({
      path: userPath,
      source: 'user',
      content: await expandImports(userRaw, dirname(userPath), home),
    });
  }

  // 2 + 3. Walk project-root → cwd
  const root = (await findProjectRoot(cwd)) ?? cwd;
  const ancestors = listAncestors(root, cwd);
  for (let i = 0; i < ancestors.length; i++) {
    const dir = ancestors[i]!;
    const filePath = join(dir, 'CLAUDE.md');
    const raw = await tryRead(filePath);
    if (raw === null) continue;
    out.push({
      path: filePath,
      source: i === 0 ? 'project' : 'directory',
      content: await expandImports(raw, dir, home),
    });
  }

  // Drop duplicates (e.g. when project root === cwd, both could land on the
  // same file). Keep the more specific entry.
  const seen = new Set<string>();
  return out.filter((f) => {
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

/**
 * Format the loaded CLAUDE.md files as a system-prompt section that mirrors
 * Claude Code's structure: one preamble + one `Contents of <path>` block per
 * file, with the strong "IMPORTANT" override note up front.
 */
export function renderClaudeMdSection(files: ClaudeMdFile[]): string {
  if (files.length === 0) return '';
  const parts: string[] = [
    '# claudeMd',
    'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.',
    '',
  ];
  for (const file of files) {
    parts.push(`Contents of ${file.path} (${describeSource(file.source)}):`);
    parts.push('');
    parts.push(file.content.trim());
    parts.push('');
  }
  // Small instruction-tuned models often re-Read these files anyway because
  // their training rewards "gather context first". State the obvious to
  // suppress that habit.
  const paths = files.map((f) => f.path).join(', ');
  parts.push(
    `NOTE: The file(s) above (${paths}) are already loaded into your context. ` +
      `Do not call Read on them again — you already have their full contents. ` +
      `When the user asks about the project, answer directly from the content above.`,
  );
  return parts.join('\n').trimEnd();
}

function describeSource(source: ClaudeMdSource): string {
  switch (source) {
    case 'user':
      return 'user instructions, applied to all projects';
    case 'project':
      return 'project instructions, checked into the codebase';
    case 'directory':
      return 'directory-specific instructions';
  }
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function findProjectRoot(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  while (true) {
    try {
      const info = await stat(join(dir, '.git'));
      if (info.isDirectory() || info.isFile()) return dir;
    } catch {
      /* not here */
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Returns directories from `top` (inclusive) down to `cwd` (inclusive), in
 * order. If `cwd` isn't inside `top`, returns just `[cwd]`.
 */
function listAncestors(top: string, cwd: string): string[] {
  const cwdAbs = resolve(cwd);
  const topAbs = resolve(top);
  if (!cwdAbs.startsWith(topAbs)) return [cwdAbs];

  const out: string[] = [];
  let dir = cwdAbs;
  while (true) {
    out.unshift(dir);
    if (dir === topAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

async function expandImports(
  content: string,
  baseDir: string,
  home: string,
  depth = 0,
  visited = new Set<string>(),
): Promise<string> {
  if (depth >= MAX_IMPORT_DEPTH) return content;

  // Match `@<path>` on a line (optionally indented), with the path being a
  // bare token (no spaces). Must be the only non-whitespace on the line.
  const re = /^[ \t]*@([^\s]+)[ \t]*$/gm;
  const matches: { full: string; path: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    matches.push({ full: m[0]!, path: m[1]! });
  }
  if (matches.length === 0) return content;

  let result = content;
  for (const { full, path: p } of matches) {
    const resolved = resolveImportPath(p, baseDir, home);
    if (visited.has(resolved)) continue; // cycle guard
    const importedRaw = await tryRead(resolved);
    if (importedRaw === null) continue; // leave the @line untouched
    const nested = new Set(visited);
    nested.add(resolved);
    const expanded = await expandImports(
      importedRaw,
      dirname(resolved),
      home,
      depth + 1,
      nested,
    );
    result = result.split(full).join(expanded.trimEnd());
  }
  return result;
}

function resolveImportPath(p: string, baseDir: string, home: string): string {
  if (p.startsWith('~/')) return join(home, p.slice(2));
  if (isAbsolute(p)) return p;
  return resolve(baseDir, p);
}
