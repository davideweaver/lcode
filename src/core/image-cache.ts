import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ImageBlock, ImageMediaType } from './messages.js';

const CACHE_ROOT = join(homedir(), '.lcode', 'image-cache');
const COUNTER_FILE = join(CACHE_ROOT, '.next-id.json');

/** Per-session cache directory, lazily created. */
export async function getCacheDir(sessionId: string): Promise<string> {
  const dir = join(CACHE_ROOT, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

let counterCache: number | null = null;

/**
 * Allocate the next global image number and return the path the caller
 * should write to. The counter is global across sessions (matches Claude
 * Code's behavior — numbers grow monotonically over time, never reset).
 *
 * If the counter file is missing or unparseable, we rebuild from disk by
 * walking existing cache dirs for the max numeric filename and picking
 * `max+1`. That makes manual cache deletion safe.
 */
export async function allocateNext(
  sessionId: string,
): Promise<{ n: number; path: string; mediaType: ImageMediaType }> {
  const next = await readAndIncrementCounter();
  const dir = await getCacheDir(sessionId);
  return { n: next, path: join(dir, `${next}.png`), mediaType: 'image/png' };
}

async function readAndIncrementCounter(): Promise<number> {
  await fs.mkdir(CACHE_ROOT, { recursive: true });
  if (counterCache === null) {
    counterCache = await loadCounter();
  }
  const n = counterCache;
  counterCache = n + 1;
  // Best-effort persist; a failed write doesn't block the paste.
  fs.writeFile(COUNTER_FILE, JSON.stringify({ next: counterCache }) + '\n', 'utf8').catch(
    () => {
      // ignore — next allocateNext will rebuild from disk if needed
    },
  );
  return n;
}

async function loadCounter(): Promise<number> {
  try {
    const raw = await fs.readFile(COUNTER_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { next?: unknown };
    if (typeof parsed.next === 'number' && Number.isFinite(parsed.next) && parsed.next >= 1) {
      return Math.floor(parsed.next);
    }
  } catch {
    // Missing or corrupt — fall through to disk rebuild.
  }
  return rebuildCounterFromDisk();
}

async function rebuildCounterFromDisk(): Promise<number> {
  let max = 0;
  try {
    const sessionDirs = await fs.readdir(CACHE_ROOT, { withFileTypes: true });
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const dir = join(CACHE_ROOT, entry.name);
      let files: string[] = [];
      try {
        files = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        const m = /^(\d+)\.png$/.exec(f);
        if (!m) continue;
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > max) max = n;
      }
    }
  } catch {
    // No cache root yet → start at 1.
  }
  return max + 1;
}

export class ImageCacheMissError extends Error {
  constructor(public readonly path: string) {
    super(`image cache file missing: ${path}`);
    this.name = 'ImageCacheMissError';
  }
}

/**
 * Resolve an image block to its base64 form for sending to the LLM.
 * If the block already carries base64 data, return it as-is. If it's a
 * file_path block, read the file and encode. Throws ImageCacheMissError
 * when the file doesn't exist so callers can substitute a text stub
 * rather than failing the whole turn.
 */
export async function resolveImageBlock(
  block: ImageBlock,
): Promise<{ mediaType: ImageMediaType; base64: string }> {
  if (block.source.type === 'base64') {
    return { mediaType: block.source.media_type, base64: block.source.data };
  }
  const { path, media_type } = block.source;
  let buf: Buffer;
  try {
    buf = await fs.readFile(path);
  } catch {
    throw new ImageCacheMissError(path);
  }
  return { mediaType: media_type, base64: buf.toString('base64') };
}
