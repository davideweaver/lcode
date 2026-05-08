import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { sessionFilePath } from './session.js';
import type { SDKMessage } from './messages.js';

export interface SessionSummary {
  sessionId: string;
  filePath: string;
  cwd: string;
  modifiedMs: number;
  sizeBytes: number;
  /** First user prompt extracted from the JSONL, used as a list label. */
  title: string;
  /** Number of turns (approximate — counted as `result` messages). */
  turns: number;
}

/**
 * List all sessions stored for a given cwd, newest first.
 *
 * We resolve the project dir from the same encoding `sessionFilePath` uses,
 * so this stays in sync with where the loop writes.
 */
export async function listSessions(cwd: string): Promise<SessionSummary[]> {
  const dir = dirname(sessionFilePath('placeholder', cwd));
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const summaries: SessionSummary[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.replace(/\.jsonl$/, '');
    const filePath = join(dir, name);
    try {
      const info = await stat(filePath);
      const summary = await summarizeSession(filePath, sessionId, cwd, info);
      if (summary) summaries.push(summary);
    } catch {
      // skip unreadable files
    }
  }

  summaries.sort((a, b) => b.modifiedMs - a.modifiedMs);
  return summaries;
}

async function summarizeSession(
  filePath: string,
  sessionId: string,
  cwd: string,
  info: { mtimeMs: number; size: number },
): Promise<SessionSummary | null> {
  const raw = await readFile(filePath, 'utf8');
  let title = '(empty session)';
  let turns = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let msg: SDKMessage;
    try {
      msg = JSON.parse(line) as SDKMessage;
    } catch {
      continue;
    }
    if (title === '(empty session)' && msg.type === 'user') {
      const text = extractUserText(msg.message.content);
      if (text) title = oneLine(text);
    }
    if (msg.type === 'result') turns++;
  }
  return {
    sessionId,
    filePath,
    cwd,
    modifiedMs: info.mtimeMs,
    sizeBytes: info.size,
    title,
    turns,
  };
}

function extractUserText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      (block as { type?: string }).type === 'text'
    ) {
      const text = (block as { text?: string }).text;
      if (text) return text;
    }
  }
  return null;
}

function oneLine(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

export function relativeTime(modifiedMs: number, nowMs = Date.now()): string {
  const diff = Math.max(0, nowMs - modifiedMs);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.round(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

// keep a re-export of homedir for tests that need to point elsewhere
export const _homedir = homedir;
