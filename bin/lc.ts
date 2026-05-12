#!/usr/bin/env node
import { Command } from 'commander';
import { render } from 'ink';
import { createElement } from 'react';
import { loadConfig } from '../src/config.js';
import { probeLlm } from '../src/health.js';
import { runHeadless } from '../src/headless.js';
import { App } from '../src/tui/app.js';
import { detectTerminalTheme } from '../src/tui/theme-detect.js';

const program = new Command();

program
  .name('lcode')
  .description('lcode — local Claude Code replica')
  .version('0.0.1')
  .option('--resume <sessionId>', 'Resume an existing session by id')
  .option('--model <model>', 'Override the configured model for this session')
  .option(
    '--no-agent-files',
    'Skip loading PERSONA/HUMAN/CAPABILITIES/INSTRUCTIONS from ~/.lcode/settings.json; use built-in defaults',
  )
  .option(
    '-p, --prompt <text>',
    'Run a single non-interactive turn, stream the response to stdout, print per-phase timings to stderr, and exit',
  )
  .option('--no-mcp', 'Skip MCP server discovery and connection; run with builtin tools only')
  .option(
    '--sys-prompt <text>',
    'Replace the entire default system prompt with this string. Skips agent files, CLAUDE.md, environment, and tool guidance.',
  )
  .option(
    '--no-thinking',
    'Disable the LLM thinking phase (chat_template_kwargs.enable_thinking=false). Recommended for voice/latency-sensitive runs.',
  )
  .action(async (opts: { resume?: string; model?: string; agentFiles: boolean; prompt?: string; mcp: boolean; sysPrompt?: string; thinking: boolean }) => {
    const config = loadConfig();
    if (opts.model) config.model = opts.model;

    if (opts.prompt !== undefined) {
      const code = await runHeadless({
        prompt: opts.prompt,
        config,
        model: opts.model,
        resume: opts.resume,
        skipAgentFiles: !opts.agentFiles,
        skipMcp: !opts.mcp,
        overrideSystemPrompt: opts.sysPrompt,
        enableThinking: opts.thinking,
      });
      process.exit(code);
    }

    // Detect the terminal theme before Ink takes over stdin. The OSC 11
    // exchange has to finish before render() runs, so we await here. If
    // detection fails the helper resolves to 'dark'.
    process.env.LCODE_THEME = await detectTerminalTheme();
    process.stdout.write('\n');

    let lastSessionId: string | undefined = opts.resume;
    // exitOnCtrlC: false — App owns Ctrl+C handling (single press cancels
    // the running turn, double press exits).
    const instance = render(
      createElement(App, {
        config,
        resume: opts.resume,
        skipAgentFiles: !opts.agentFiles,
        skipMcp: !opts.mcp,
        overrideSystemPrompt: opts.sysPrompt,
        enableThinking: opts.thinking,
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
