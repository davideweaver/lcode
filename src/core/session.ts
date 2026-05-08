import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SDKMessage } from './messages.js';

const ROOT = join(homedir(), '.lcode', 'projects');

export interface Session {
  sessionId: string;
  cwd: string;
  filePath: string;
}

export function newSessionId(): string {
  return randomUUID();
}

export function sessionFilePath(sessionId: string, cwd: string): string {
  const encoded = cwd.replace(/[/\\:]/g, '-').replace(/^-+/, '');
  return join(ROOT, encoded, `${sessionId}.jsonl`);
}

export async function openSession(
  sessionId: string,
  cwd: string,
): Promise<Session> {
  const filePath = sessionFilePath(sessionId, cwd);
  await mkdir(dirname(filePath), { recursive: true });
  return { sessionId, cwd, filePath };
}

export async function appendMessage(
  session: Session,
  message: SDKMessage,
): Promise<void> {
  await appendFile(session.filePath, JSON.stringify(message) + '\n', 'utf8');
}

export async function loadSessionMessages(
  sessionId: string,
  cwd: string,
): Promise<SDKMessage[]> {
  const filePath = sessionFilePath(sessionId, cwd);
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: SDKMessage[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SDKMessage);
    } catch {
      // skip corrupted lines
    }
  }
  return out;
}
