// Pure helpers for terminal-theme detection. Kept ESM-JS (not TS) so the
// launcher (bin/lcode) can import them without going through tsx, while
// vitest can still load them for unit tests.

/**
 * Parse the COLORFGBG env var, set by some terminals (rxvt, Konsole,
 * iTerm2 with the right preference, Apple Terminal sometimes). Format
 * is `<fg>;<bg>` or `<fg>;<default>;<bg>` where each field is an ANSI
 * 0-15 index.
 *
 * @param {string | undefined} value
 * @returns {'dark' | 'light' | null}
 */
export function parseColorFgBg(value) {
  if (!value) return null;
  const parts = value.split(';');
  const last = parts[parts.length - 1];
  if (last == null) return null;
  const idx = Number.parseInt(last, 10);
  if (!Number.isFinite(idx)) return null;
  // 0 (black) and 8 (bright black / dark gray) → dark theme.
  // 7 (white) and 15 (bright white) → light theme.
  // Anything else: ambiguous, return null and let detection fall through.
  if (idx === 0 || idx === 8) return 'dark';
  if (idx === 7 || idx === 15) return 'light';
  return null;
}

/**
 * Parse a terminal's OSC 11 response. The terminal echoes back something
 * like `\x1b]11;rgb:RRRR/GGGG/BBBB\x07` (or `\x1b]11;rgb:RR/GG/BB\x07`,
 * or with a `\x1b\\` ST terminator). Each component is 1-4 hex digits;
 * we use the leading byte for luminance.
 *
 * @param {string} response Raw bytes received from stdin.
 * @returns {'dark' | 'light' | null}
 */
export function parseOsc11Response(response) {
  if (!response) return null;
  const m = response.match(
    /\x1b\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/,
  );
  if (!m) return null;
  const r = leadByte(m[1]);
  const g = leadByte(m[2]);
  const b = leadByte(m[3]);
  // Standard luminance formula. Threshold 0.5 (out of 1) splits dark/light.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.5 ? 'dark' : 'light';
}

function leadByte(hex) {
  // OSC 11 components can be 1-4 hex digits per channel. Use the high byte.
  if (hex.length >= 2) return Number.parseInt(hex.slice(0, 2), 16);
  return Number.parseInt(hex, 16) * 17; // expand single digit (0xF -> 0xFF)
}
