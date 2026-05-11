import { parse as dotenvParse } from 'dotenv';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Resolution order for LCODE_* environment variables:
//   1. Shell environment (always wins)
//   2. `${cwd}/.env` (project-local, e.g. lcode's own dev config)
//   3. `~/.lcode/.env` (user-global fallback for `lc` from any directory)
//
// We deliberately only adopt LCODE_* variables from .env files — running
// `lc` from another project's checkout (where the .env may legitimately
// set things like NODE_TLS_REJECT_UNAUTHORIZED, DATABASE_URL, etc.)
// shouldn't pollute lcode's process env or trigger Node TLS warnings.
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  let parsed: Record<string, string>;
  try {
    parsed = dotenvParse(readFileSync(path));
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (!k.startsWith('LCODE_')) continue;
    if (process.env[k] !== undefined) continue;
    process.env[k] = v;
  }
}

loadEnvFile(join(process.cwd(), '.env'));
loadEnvFile(join(homedir(), '.lcode', '.env'));

export interface LcodeConfig {
  llmUrl: string;
  model: string;
  apiKey: string;
  /** Context window in tokens. Used to compute the statusline percentage. */
  contextWindow: number;
  /**
   * Fraction of contextWindow at which auto-compaction triggers. Values
   * close to 1.0 wait until the prompt is nearly full; lower values
   * compact earlier with more headroom. Clamped to (0, 1].
   */
  compactThreshold: number;
  /**
   * SearXNG base URL used by the WebSearch tool. Empty string disables
   * WebSearch — the tool errors with a setup hint when invoked.
   */
  searxngUrl: string;
}

export function loadConfig(): LcodeConfig {
  const rawThreshold = parseFloat(process.env.LCODE_COMPACT_THRESHOLD ?? '0.75');
  const compactThreshold = Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold <= 1
    ? rawThreshold
    : 0.75;
  return {
    llmUrl: normalizeBaseUrl(process.env.LCODE_LLM_URL ?? 'http://llm.appkit.local:9100/v1'),
    model: process.env.LCODE_MODEL ?? 'gemma4',
    apiKey: process.env.LCODE_API_KEY ?? 'sk-not-needed',
    contextWindow: parseInt(process.env.LCODE_CONTEXT_WINDOW ?? '32768', 10),
    compactThreshold,
    searxngUrl: (process.env.LCODE_SEARXNG_URL ?? 'http://172.16.0.14:3274').replace(/\/+$/, ''),
  };
}

/**
 * Strip trailing slash and a trailing /v1 (or /v1/) so that callers can pass
 * either form of base URL. lcode appends /v1/... itself.
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}
