import { homedir } from 'node:os';
import type { LcodeConfig } from '../config.js';
import { formatTokenCount } from './tokens.js';

const VERSION = '0.0.1';

/**
 * Build the lcode startup banner as a plain string with ANSI styling.
 * Printed to stdout once before Ink mounts, so it scrolls naturally as
 * the live region updates below it.
 *
 * Format mirrors Claude Code's three-line header:
 *   <name> v<version>
 *   <model> (<context> context) · <endpoint>
 *   <cwd-with-tilde>
 */
export function renderBanner(config: LcodeConfig, cwd: string): string {
  const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
  // ANSI 90 = bright black, the same shade Ink renders for `color="gray"`
  // — matches the muted text we use throughout the TUI.
  const gray = (s: string) => `\x1b[90m${s}\x1b[39m`;

  const ctx = formatTokenCount(config.contextWindow);
  const home = homedir();
  const displayPath =
    cwd === home
      ? '~'
      : cwd.startsWith(home + '/')
        ? '~' + cwd.slice(home.length)
        : cwd;

  const themeLabel = (process.env.LCODE_THEME ?? 'unset').toLowerCase();

  const line1 = `${bold('lcode')} ${dim(`v${VERSION}`)}`;
  const line2 = gray(
    `${config.model} (${ctx} context) · ${config.llmUrl} · theme: ${themeLabel}`,
  );
  const line3 = gray(displayPath);

  return [line1, line2, line3].join('\n');
}
