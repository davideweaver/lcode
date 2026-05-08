import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read the current git branch by parsing `.git/HEAD` directly.
 * Avoids spawning `git`. Returns null if cwd isn't a git repo or is detached.
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
  try {
    const head = await readFile(join(cwd, '.git', 'HEAD'), 'utf8');
    const trimmed = head.trim();
    const m = trimmed.match(/^ref:\s+refs\/heads\/(.+)$/);
    if (m && m[1]) return m[1];
    // Detached HEAD — show short SHA
    if (/^[0-9a-f]{7,}$/i.test(trimmed)) return trimmed.slice(0, 7);
    return null;
  } catch {
    return null;
  }
}
