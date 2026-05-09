import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DisabledOptions {
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
  /** Sink for parse errors. Defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

/**
 * Path to the persistent disabled-servers file. Lives at
 * `~/.lcode/mcp-disabled.json` so it's user-scope and survives restarts,
 * independent of which config layer (`~/.lcode/mcp.json`, project `.mcp.json`,
 * `~/.claude.json`) the server was originally declared in.
 */
function disabledFilePath(homeDir: string): string {
  return join(homeDir, '.lcode', 'mcp-disabled.json');
}

/**
 * Read the persisted disabled-servers set. Returns an empty set if the file
 * is missing or malformed — the user can always re-disable via the picker.
 */
export async function loadDisabledServers(opts: DisabledOptions = {}): Promise<Set<string>> {
  const home = opts.homeDir ?? homedir();
  const warn = opts.onWarn ?? ((m) => console.warn(`[mcp] ${m}`));
  const path = disabledFilePath(home);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`${path}: invalid JSON — ignoring (${err instanceof Error ? err.message : err})`);
    return new Set();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warn(`${path}: expected object with 'disabled' array — ignoring`);
    return new Set();
  }
  const list = (parsed as { disabled?: unknown }).disabled;
  if (!Array.isArray(list)) return new Set();
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item === 'string' && item.length > 0) out.add(item);
  }
  return out;
}

/**
 * Add or remove a server from the disabled list and persist atomically.
 * Creates `~/.lcode/` if it doesn't yet exist.
 */
export async function setServerDisabled(
  name: string,
  disabled: boolean,
  opts: DisabledOptions = {},
): Promise<void> {
  const home = opts.homeDir ?? homedir();
  const path = disabledFilePath(home);
  const current = await loadDisabledServers(opts);
  if (disabled) {
    if (current.has(name)) return;
    current.add(name);
  } else {
    if (!current.has(name)) return;
    current.delete(name);
  }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = JSON.stringify({ disabled: [...current].sort() }, null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}
