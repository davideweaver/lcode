import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Resolved agent-identity strings used by `buildSystemPrompt`. Each field is
 * either the trimmed contents of the user's `~/.lcode/<file>` (when enabled
 * in `~/.lcode/settings.json`) or a hard-coded default that matches the
 * pre-configurable behavior of lcode.
 */
export interface AgentFiles {
  persona: string;
  human: string;
  capabilities: string;
  instructions: string;
}

export interface LoadAgentFilesOptions {
  /** Override for tests; defaults to os.homedir(). */
  homeDir?: string;
  /** Sink for warnings. Defaults to console.warn with `[agents]` prefix. */
  onWarn?: (msg: string) => void;
}

type AgentKey = 'persona' | 'human' | 'capabilities' | 'instructions';

interface AgentEntry {
  enabled: boolean;
  file: string;
}

interface SettingsShape {
  agentFiles: Record<AgentKey, AgentEntry>;
}

const KEYS: AgentKey[] = ['persona', 'human', 'capabilities', 'instructions'];

const DEFAULT_PERSONA = `You are lcode, a local coding assistant running on a small open-weight model. \
You behave like Claude Code: you read and edit files, run shell commands, and search the codebase to complete software engineering tasks. \
You are not Claude. Be honest about that if asked.`;

const DEFAULT_HUMAN = `You are working with a software engineer at a terminal. \
Address them directly when you need clarification.`;

const DEFAULT_CAPABILITIES = `You can read and edit files, run shell commands, search the codebase, and call any MCP tools the user has configured. \
The exact tool list and rules are in the Tools section below.`;

const DEFAULT_INSTRUCTIONS = `- Be terse. State what you're doing in one short sentence before tool calls when useful.
- Don't narrate internal deliberation. Don't summarize what just happened — the user can see the tool results.
- When you reference code, cite as path:line so the user can navigate.`;

const DEFAULTS: AgentFiles = {
  persona: DEFAULT_PERSONA,
  human: DEFAULT_HUMAN,
  capabilities: DEFAULT_CAPABILITIES,
  instructions: DEFAULT_INSTRUCTIONS,
};

/**
 * Returns the static defaults — useful for `buildSystemPrompt` callers that
 * skip `loadAgentFiles` entirely (tests, programmatic SDK consumers).
 */
export function defaultAgentFiles(): AgentFiles {
  return { ...DEFAULTS };
}

/**
 * Read `~/.lcode/settings.json` and resolve each section.
 *
 *   - Missing settings.json → write the default skeleton, then proceed.
 *   - Malformed settings.json → warn and treat all entries as disabled,
 *     without overwriting the file.
 *   - For each enabled key, read the configured filename from `~/.lcode/`;
 *     fall back to the hard-coded default on missing/empty content.
 */
export async function loadAgentFiles(
  opts: LoadAgentFilesOptions = {},
): Promise<AgentFiles> {
  const home = opts.homeDir ?? homedir();
  const warn = opts.onWarn ?? ((m) => console.warn(`[agents] ${m}`));

  const settings = await readOrCreateSettings(home, warn);
  const out: AgentFiles = { ...DEFAULTS };

  for (const key of KEYS) {
    const entry = settings.agentFiles[key];
    if (!entry.enabled) continue;
    const path = join(home, '.lcode', entry.file);
    const raw = await tryRead(path);
    if (raw === null) {
      warn(`${path}: file not found — using default for "${key}"`);
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      warn(`${path}: file empty — using default for "${key}"`);
      continue;
    }
    out[key] = trimmed;
  }
  return out;
}

function settingsPath(home: string): string {
  return join(home, '.lcode', 'settings.json');
}

function defaultSettings(): SettingsShape {
  return {
    agentFiles: {
      persona: { enabled: false, file: 'PERSONA.md' },
      human: { enabled: false, file: 'HUMAN.md' },
      capabilities: { enabled: false, file: 'CAPABILITIES.md' },
      instructions: { enabled: false, file: 'INSTRUCTIONS.md' },
    },
  };
}

async function readOrCreateSettings(
  home: string,
  warn: (msg: string) => void,
): Promise<SettingsShape> {
  const path = settingsPath(home);
  let text: string | null;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    // File missing → seed it on disk, return in-memory default.
    await writeDefaultSettings(home);
    return defaultSettings();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(
      `${path}: invalid JSON — using defaults (${err instanceof Error ? err.message : err})`,
    );
    return defaultSettings();
  }

  return normalize(parsed, path, warn);
}

async function writeDefaultSettings(home: string): Promise<void> {
  const path = settingsPath(home);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(defaultSettings(), null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  await rename(tmp, path);
}

function normalize(
  raw: unknown,
  path: string,
  warn: (msg: string) => void,
): SettingsShape {
  const skeleton = defaultSettings();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`${path}: expected object — using defaults`);
    return skeleton;
  }
  const af = (raw as { agentFiles?: unknown }).agentFiles;
  if (!af || typeof af !== 'object' || Array.isArray(af)) {
    return skeleton;
  }
  const merged: Record<AgentKey, AgentEntry> = { ...skeleton.agentFiles };
  for (const key of KEYS) {
    const entry = (af as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as { enabled?: unknown; file?: unknown };
    const enabled = typeof e.enabled === 'boolean' ? e.enabled : false;
    const file =
      typeof e.file === 'string' && e.file.length > 0
        ? e.file
        : skeleton.agentFiles[key].file;
    merged[key] = { enabled, file };
  }
  return { agentFiles: merged };
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}
