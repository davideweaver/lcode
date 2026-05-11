import { execFile, spawn } from 'node:child_process';
import { createWriteStream, promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { ImageMediaType } from './messages.js';

const execFileAsync = promisify(execFile);

/**
 * Read an image from the system clipboard and write it to `destPath`.
 * Returns the media type on success, or `null` if there's no image on the
 * clipboard / the platform isn't supported / the toolchain is missing.
 *
 * macOS uses `osascript` with the `«class PNGf»` clipboard coercion to write
 * PNG bytes directly to a file. We DELIBERATELY skip the hex-dump precheck
 * Claude Code originally shipped — that script writes the entire image as
 * hex through stdout and trips Node's default exec buffer (~1MB) with
 * ENOBUFS on real screenshots. Saving directly and branching on the exit
 * code is faster and more reliable.
 *
 * Linux pipes `xclip`/`wl-paste` stdout straight to a file write stream so
 * we never buffer the image in Node memory. Any failure (no image on
 * clipboard, tool not installed, MIME type unavailable) collapses to null.
 */
export async function tryReadClipboardImage(
  destPath: string,
): Promise<{ mediaType: ImageMediaType } | null> {
  if (process.platform === 'darwin') return tryMac(destPath);
  if (process.platform === 'linux') return tryLinux(destPath);
  if (process.platform === 'win32') {
    warnOnce('Image paste is not yet supported on Windows.');
    return null;
  }
  return null;
}

async function tryMac(destPath: string): Promise<{ mediaType: ImageMediaType } | null> {
  // The «class PNGf» coercion fails (non-zero exit) when the clipboard
  // doesn't hold image data, which is exactly the signal we want.
  const script = [
    'set png_data to (the clipboard as «class PNGf»)',
    `set fp to open for access POSIX file ${appleScriptString(destPath)} with write permission`,
    'set eof of fp to 0',
    'write png_data to fp',
    'close access fp',
  ];
  const args: string[] = [];
  for (const line of script) {
    args.push('-e', line);
  }
  try {
    await execFileAsync('osascript', args, { maxBuffer: 1024 * 1024 });
  } catch {
    // No image on the clipboard, or osascript blew up — either way, nothing
    // to attach. Clean up any zero-byte file the open-for-access left behind.
    await safeUnlink(destPath);
    return null;
  }
  // Sanity check: did the write actually produce a non-empty PNG?
  try {
    const stat = await fs.stat(destPath);
    if (stat.size === 0) {
      await safeUnlink(destPath);
      return null;
    }
  } catch {
    return null;
  }
  return { mediaType: 'image/png' };
}

async function tryLinux(destPath: string): Promise<{ mediaType: ImageMediaType } | null> {
  const useWayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland');
  if (useWayland) {
    return spawnToFile('wl-paste', ['--type', 'image/png'], destPath);
  }
  return spawnToFile('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], destPath);
}

function spawnToFile(
  command: string,
  args: string[],
  destPath: string,
): Promise<{ mediaType: ImageMediaType } | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    const stream = createWriteStream(destPath);
    let stderrBuf = '';
    child.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-4096);
    });
    child.stdout.pipe(stream);
    child.on('error', async () => {
      stream.destroy();
      await safeUnlink(destPath);
      resolve(null);
    });
    child.on('close', async (code) => {
      stream.end();
      if (code !== 0) {
        await safeUnlink(destPath);
        return resolve(null);
      }
      try {
        const stat = await fs.stat(destPath);
        if (stat.size === 0) {
          await safeUnlink(destPath);
          return resolve(null);
        }
      } catch {
        return resolve(null);
      }
      resolve({ mediaType: 'image/png' });
    });
  });
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // ignore
  }
}

/**
 * Wrap a JavaScript string in AppleScript double-quote syntax with proper
 * escaping for backslash and double-quote.
 */
function appleScriptString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  // eslint-disable-next-line no-console
  console.error(msg);
}
