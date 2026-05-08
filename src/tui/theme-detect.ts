import type { ThemeName } from './theme.js';

/**
 * Detect the terminal background colour and resolve to a theme name.
 *
 * Runs inside the TUI process (not the launcher) so that the OSC 11
 * exchange happens against the real, inherited stdin/stdout — no env
 * variable plumbing between processes. Call this before Ink's render()
 * takes over stdin.
 *
 * Resolution order:
 *   1. LCODE_THEME explicit override ('dark' | 'light')
 *   2. COLORFGBG (set by some terminals)
 *   3. OSC 11 query against the terminal
 *   4. Default 'dark'
 */
export async function detectTerminalTheme(timeoutMs = 500): Promise<ThemeName> {
  const override = (process.env.LCODE_THEME ?? '').toLowerCase();
  if (override === 'dark' || override === 'light') return override;

  const fromEnv = parseColorFgBg(process.env.COLORFGBG);
  if (fromEnv) return fromEnv;

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const fromOsc = await queryOsc11(timeoutMs);
    if (fromOsc) return fromOsc;
  }

  return 'dark';
}

/**
 * Parse COLORFGBG (e.g. `15;0` or `15;default;0`). Returns 'dark' for
 * bg index 0/8 (black-ish), 'light' for 7/15 (white-ish), null for
 * anything ambiguous or missing.
 */
export function parseColorFgBg(value: string | undefined): ThemeName | null {
  if (!value) return null;
  const parts = value.split(';');
  const last = parts[parts.length - 1];
  if (last == null) return null;
  const idx = Number.parseInt(last, 10);
  if (!Number.isFinite(idx)) return null;
  if (idx === 0 || idx === 8) return 'dark';
  if (idx === 7 || idx === 15) return 'light';
  return null;
}

/**
 * Parse a terminal's OSC 11 background-colour reply, e.g.
 *   ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL
 *   ESC ] 11 ; rgb:RR/GG/BB ESC \\
 * Uses standard luminance with a 0.5 cutoff.
 */
export function parseOsc11Response(response: string): ThemeName | null {
  if (!response) return null;
  const m = response.match(
    /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/,
  );
  if (!m) return null;
  const r = leadByte(m[1]!);
  const g = leadByte(m[2]!);
  const b = leadByte(m[3]!);
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.5 ? 'dark' : 'light';
}

function leadByte(hex: string): number {
  if (hex.length >= 2) return Number.parseInt(hex.slice(0, 2), 16);
  return Number.parseInt(hex, 16) * 17;
}

function queryOsc11(timeoutMs: number): Promise<ThemeName | null> {
  return new Promise<ThemeName | null>((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
      resolve(null);
      return;
    }

    const wasRaw = stdin.isRaw;
    let buf = '';
    let settled = false;

    const cleanup = (result: ThemeName | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.off('data', onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* stdin already closed — ignore */
      }
      stdin.pause();
      resolve(result);
    };

    const onData = (chunk: Buffer | string) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const parsed = parseOsc11Response(buf);
      if (parsed) cleanup(parsed);
    };

    try {
      stdin.setRawMode(true);
    } catch {
      resolve(null);
      return;
    }
    stdin.resume();
    stdin.on('data', onData);
    stdout.write('\x1b]11;?\x07');
    const timer = setTimeout(() => cleanup(null), timeoutMs);
  });
}
