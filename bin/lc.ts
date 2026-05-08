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
  .name('lc')
  .description('lcode — local Claude Code replica')
  .version('0.0.1');

program
  .command('chat', { isDefault: true })
  .description('Open the interactive TUI (default)')
  .option('--resume <sessionId>', 'Resume an existing session by id')
  .action(async (opts: { resume?: string }) => {
    const config = loadConfig();
    // Detect the terminal theme before Ink takes over stdin. The OSC 11
    // exchange has to finish before render() runs, so we await here. If
    // detection fails the helper resolves to 'dark'.
    process.env.LCODE_THEME = await detectTerminalTheme();
    process.stdout.write('\n' + renderBanner(config, process.cwd()) + '\n\n');
    render(createElement(App, { config, resume: opts.resume }));
  });

program
  .command('health')
  .description('Probe the configured LLM endpoint and exit')
  .action(async () => {
    const config = loadConfig();
    const result = await probeLlm(config);
    console.log(JSON.stringify({ config, result }, null, 2));
    process.exit(result.ok ? 0 : 1);
  });

program.parse();
