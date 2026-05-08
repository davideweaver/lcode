import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { tool } from '../helper.js';

const schema = z.object({
  pattern: z.string().describe('Glob pattern (e.g., "**/*.ts", "src/**/*.tsx").'),
  path: z
    .string()
    .optional()
    .describe('Absolute root directory to search. Defaults to cwd.'),
});

const MAX_RESULTS = 1000;

export const GlobTool = tool(
  'Glob',
  'List files matching a glob pattern. Supports **, *, ?, [...] character classes. ' +
    'Returns up to 1000 paths sorted by modification time, most recent first.',
  schema,
  async (input, ctx) => {
    const root = input.path ?? ctx.cwd;
    if (!isAbsolute(root)) {
      return { content: `Error: path must be absolute. Got: ${root}`, isError: true };
    }
    const matcher = compileGlob(input.pattern);
    const matches: { path: string; mtime: number }[] = [];
    try {
      await walk(root, root, matcher, matches, ctx.signal);
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { content: 'Error: aborted.', isError: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: ${msg}`, isError: true };
    }
    matches.sort((a, b) => b.mtime - a.mtime);
    const truncated = matches.length > MAX_RESULTS;
    const out = matches
      .slice(0, MAX_RESULTS)
      .map((m) => m.path)
      .join('\n');
    const summary = truncated
      ? `\n[truncated to ${MAX_RESULTS} of ${matches.length} matches]`
      : matches.length === 0
        ? '(no matches)'
        : '';
    return { content: out + summary };
  },
  { readOnly: true },
);

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.turbo', '.cache']);

async function walk(
  rootAbs: string,
  dir: string,
  matcher: (relPath: string) => boolean,
  out: { path: string; mtime: number }[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(rootAbs, abs, matcher, out, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(rootAbs, abs).split(sep).join('/');
    if (matcher(rel)) {
      try {
        const info = await stat(abs);
        out.push({ path: abs, mtime: info.mtimeMs });
      } catch {
        /* ignore */
      }
    }
    if (out.length >= MAX_RESULTS * 2) return;
  }
}

/**
 * Translate a glob pattern to a regex matcher. Supports **, *, ?, [...] and / separators.
 */
function compileGlob(pattern: string): (relPath: string) => boolean {
  const regex = globToRegex(pattern);
  return (rel) => regex.test(rel);
}

function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches any number of path segments
        re += '.*';
        i += 2;
        if (pattern[i] === '/') i++;
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        re += '\\[';
        i++;
      } else {
        re += pattern.slice(i, end + 1);
        i = end + 1;
      }
    } else if (/[.+^$(){}|\\]/.test(c ?? '')) {
      re += `\\${c}`;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}
