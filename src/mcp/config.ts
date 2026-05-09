import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { McpServerConfig } from './types.js';

export interface LoadMcpOptions {
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
  /** Sink for per-entry validation/load errors. Defaults to console.warn. */
  onWarn?: (msg: string) => void;
}

/**
 * Discover MCP server configs in three layers and merge them.
 *
 * Precedence (highest first):
 *   1. `~/.lcode/mcp.json`              — lcode user-scope (canonical)
 *   2. `<projectRoot>/.mcp.json`        — project-scope, same filename Claude Code uses
 *   3. `~/.claude.json` mcpServers      — opportunistic Claude Code fallback
 *
 * On duplicate name, the higher-precedence file wins. Invalid entries are
 * dropped with a warning rather than failing the whole load.
 *
 * Project root is the nearest ancestor with a `.git` entry, or `cwd` if none.
 */
export async function loadMcpServers(
  cwd: string,
  opts: LoadMcpOptions = {},
): Promise<McpServerConfig[]> {
  const home = opts.homeDir ?? homedir();
  const warn = opts.onWarn ?? ((m) => console.warn(`[mcp] ${m}`));

  const layers: { source: string; raw: unknown }[] = [];

  const lcodeUser = await tryReadJson(join(home, '.lcode', 'mcp.json'));
  if (lcodeUser !== null) layers.push({ source: '~/.lcode/mcp.json', raw: lcodeUser });

  const projectRoot = (await findProjectRoot(cwd)) ?? cwd;
  const project = await tryReadJson(join(projectRoot, '.mcp.json'));
  if (project !== null) layers.push({ source: `${projectRoot}/.mcp.json`, raw: project });

  const claudeUser = await tryReadJson(join(home, '.claude.json'));
  if (claudeUser !== null) layers.push({ source: '~/.claude.json', raw: claudeUser });

  // Higher-precedence layers come first; merge by name keeping the first
  // occurrence.
  const merged = new Map<string, McpServerConfig>();
  for (const { source, raw } of layers) {
    const entries = extractMcpServers(raw);
    if (entries === null) {
      warn(`${source}: missing or invalid 'mcpServers' object — skipped`);
      continue;
    }
    for (const [name, value] of Object.entries(entries)) {
      if (merged.has(name)) continue;
      const cfg = normalizeEntry(name, value, warn, source);
      if (cfg) merged.set(name, cfg);
    }
  }

  return [...merged.values()];
}

async function tryReadJson(path: string): Promise<unknown> {
  try {
    const text = await readFile(path, 'utf8');
    return JSON.parse(text);
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
 * Both lcode/project files and Claude Code's user file wrap servers under a
 * top-level `mcpServers` key. Return that map or null if absent/wrong shape.
 */
function extractMcpServers(raw: unknown): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  const inner = (raw as Record<string, unknown>).mcpServers;
  if (!isPlainObject(inner)) return null;
  return inner as Record<string, unknown>;
}

function normalizeEntry(
  name: string,
  raw: unknown,
  warn: (m: string) => void,
  source: string,
): McpServerConfig | null {
  if (!isPlainObject(raw)) {
    warn(`${source}: server "${name}" is not an object — skipped`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const type = inferType(obj);
  switch (type) {
    case 'stdio': {
      const command = stringField(obj, 'command');
      if (!command) {
        warn(`${source}: server "${name}" stdio config missing 'command' — skipped`);
        return null;
      }
      return {
        type: 'stdio',
        name,
        command,
        args: stringArray(obj.args),
        env: stringRecord(obj.env),
      };
    }
    case 'http':
    case 'sse': {
      const url = stringField(obj, 'url');
      if (!url) {
        warn(`${source}: server "${name}" ${type} config missing 'url' — skipped`);
        return null;
      }
      return {
        type,
        name,
        url,
        headers: stringRecord(obj.headers),
      };
    }
    default:
      warn(`${source}: server "${name}" has unknown type "${String(obj.type)}" — skipped`);
      return null;
  }
}

function inferType(obj: Record<string, unknown>): 'stdio' | 'http' | 'sse' | 'unknown' {
  const explicit = obj.type;
  if (explicit === 'stdio' || explicit === 'http' || explicit === 'sse') return explicit;
  if (explicit === 'streamable-http' || explicit === 'streamableHttp') return 'http';
  if (typeof explicit === 'string') return 'unknown';
  // No `type` field: infer from shape. `command` => stdio, `url` => http.
  if (typeof obj.command === 'string') return 'stdio';
  if (typeof obj.url === 'string') return 'http';
  return 'unknown';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) if (typeof item === 'string') out.push(item);
  return out;
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isPlainObject(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') out[k] = val;
  }
  return out;
}
