#!/usr/bin/env node
import { Command } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { loadConfig } from '../src/config.js';
import { probeLlm } from '../src/health.js';
import { App } from '../src/tui/app.js';
import { renderBanner } from '../src/tui/banner.js';
import { detectTerminalTheme } from '../src/tui/theme-detect.js';

const program = new Command();

program
  .name('lcode')
  .description('lcode — local Claude Code replica')
  .version('0.0.1')
  .option('--resume <sessionId>', 'Resume an existing session by id')
  .option('--model <model>', 'Override the configured model for this session')
  .action(async (opts: { resume?: string; model?: string }) => {
    const config = loadConfig();
    if (opts.model) config.model = opts.model;
    // Detect the terminal theme before Ink takes over stdin. The OSC 11
    // exchange has to finish before render() runs, so we await here. If
    // detection fails the helper resolves to 'dark'.
    process.env.LCODE_THEME = await detectTerminalTheme();
    process.stdout.write('\n' + renderBanner(config, process.cwd()) + '\n\n');

    let lastSessionId: string | undefined = opts.resume;
    // exitOnCtrlC: false — App owns Ctrl+C handling (single press cancels
    // the running turn, double press exits).
    const instance = render(
      createElement(App, {
        config,
        resume: opts.resume,
        onSessionChange: (id) => {
          if (id) lastSessionId = id;
        },
      }),
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
    if (lastSessionId) {
      const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
      process.stdout.write(
        `\n${dim('Resume this session with:')}\n` +
          `${dim(`lcode --resume ${lastSessionId}`)}\n\n`,
      );
    }
  });

program
  .command('health')
  .description('Probe the configured LLM endpoint and exit')
  .option('--model <model>', 'Override the configured model for this probe')
  .action(async (opts: { model?: string }) => {
    const config = loadConfig();
    if (opts.model) config.model = opts.model;
    const result = await probeLlm(config);
    console.log(JSON.stringify({ config, result }, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

program.parse();
