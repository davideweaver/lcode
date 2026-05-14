import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Env-gated structured debug log.
 *
 * Off by default. Enable with `LCODE_DEBUG=1` to capture diagnostics
 * for hangs, render storms, or input-dropping bugs. The log is JSONL
 * appended to `~/.lcode/debug/lcode-<pid>.log` so it survives process
 * exit and can be inspected after a Ctrl+C kill.
 *
 * Designed for tight loops: a single sync getter, a non-blocking
 * write-stream append, and a per-call timestamp so the reader can
 * reconstruct ordering even when categories interleave.
 */

let stream: WriteStream | null = null;
let path: string | null = null;
let enabled: boolean | null = null;
let startMs = 0;

function init(): WriteStream | null {
  if (enabled === false) return null;
  if (enabled === null) {
    enabled = process.env.LCODE_DEBUG === '1' || process.env.LCODE_DEBUG === 'true';
    if (!enabled) return null;
  }
  if (stream) return stream;
  const dir = join(homedir(), '.lcode', 'debug');
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // ENOENT impossible after mkdir recursive; EACCES means we can't log.
    enabled = false;
    return null;
  }
  path = join(dir, `lcode-${process.pid}.log`);
  stream = createWriteStream(path, { flags: 'a' });
  startMs = Date.now();
  // Header marks a fresh process attaching to (possibly existing) file.
  stream.write(
    JSON.stringify({ t: 0, c: 'session', start: new Date().toISOString(), pid: process.pid }) + '\n',
  );
  return stream;
}

export function isDebugEnabled(): boolean {
  if (enabled === null) init();
  return enabled === true;
}

export function debugLogPath(): string | null {
  if (enabled === null) init();
  return path;
}

/**
 * Append one structured event. Category is short (e.g. 'stdin', 'input',
 * 'render', 'stream'). The optional payload is shallow-stringified to keep
 * formatting cheap inside hot loops — pass small objects only.
 */
export function debugLog(category: string, payload?: Record<string, unknown>): void {
  const s = init();
  if (!s) return;
  const line =
    JSON.stringify({
      t: Date.now() - startMs,
      c: category,
      ...(payload ?? {}),
    }) + '\n';
  // write() is non-blocking; backpressure on a debug log doesn't matter
  // for correctness. Drop in practice can only happen if the kernel buffer
  // fills, which won't happen at human-scale instrumentation rates.
  s.write(line);
}
