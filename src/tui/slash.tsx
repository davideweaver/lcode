import { Box, Text } from 'ink';
import type { LcodeConfig } from '../config.js';
import type { McpManager } from '../mcp/manager.js';
import type { UiBlock } from './types.js';

export interface SlashContext {
  cwd: string;
  config: LcodeConfig;
  sessionId?: string;
  currentModel: string;
  setCurrentModel: (model: string) => void;
  addBlock: (block: UiBlock) => void;
  clearSession: () => void;
  openResumePicker: () => void;
  openModelPicker: () => void;
  openMcpPicker: () => void;
  /**
   * Manager for MCP server connections. Always present at runtime; the App
   * instantiates a single manager at session start and shares it here.
   */
  mcpManager: McpManager;
  exit: () => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  execute(args: string, ctx: SlashContext): Promise<void> | void;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'help',
    description: 'List available slash commands.',
    execute: (_args, ctx) => {
      const lines = [
        'Slash commands:',
        ...COMMANDS.map((c) => `  /${c.name.padEnd(8)} ${c.description}`),
      ];
      ctx.addBlock({ kind: 'slash_output', text: lines.join('\n') });
    },
  },
  {
    name: 'clear',
    description: 'Clear conversation history and start a fresh session.',
    execute: (_args, ctx) => {
      ctx.clearSession();
      ctx.addBlock({ kind: 'slash_output', text: '* Session cleared.' });
    },
  },
  {
    name: 'cwd',
    description: 'Print the current working directory.',
    execute: (_args, ctx) => {
      ctx.addBlock({ kind: 'slash_output', text: ctx.cwd });
    },
  },
  {
    name: 'model',
    description: 'Show the active model, or pick / set a different one.',
    execute: (args, ctx) => {
      const { llmUrl, contextWindow } = ctx.config;
      const requested = args.trim();
      if (requested) {
        ctx.setCurrentModel(requested);
        ctx.addBlock({
          kind: 'slash_output',
          text: `model: ${requested}\nendpoint: ${llmUrl}\ncontext window: ${contextWindow} tokens`,
        });
        return;
      }
      ctx.addBlock({
        kind: 'slash_output',
        text: `model: ${ctx.currentModel}\nendpoint: ${llmUrl}\ncontext window: ${contextWindow} tokens`,
      });
      ctx.openModelPicker();
    },
  },
  {
    name: 'session',
    description: 'Show the current session id.',
    execute: (_args, ctx) => {
      ctx.addBlock({
        kind: 'slash_output',
        text: ctx.sessionId ? `session: ${ctx.sessionId}` : '(no session yet — send a prompt first)',
      });
    },
  },
  {
    name: 'resume',
    description: 'Resume a previous session in this directory.',
    execute: (_args, ctx) => {
      ctx.openResumePicker();
    },
  },
  {
    name: 'mcp',
    description: 'Browse configured MCP servers. /mcp reload to reconnect all.',
    execute: async (args, ctx) => {
      const sub = args.trim();
      if (sub === 'reload') {
        ctx.addBlock({ kind: 'slash_output', text: '* reloading MCP servers…' });
        await ctx.mcpManager.reload();
        ctx.addBlock({ kind: 'slash_output', text: '* reloaded.' });
        return;
      }
      if (sub) {
        ctx.addBlock({
          kind: 'slash_output',
          text: `Unknown /mcp subcommand: ${sub}. Available: reload`,
        });
        return;
      }
      // No args: prefer the interactive picker. Fall back to a setup hint
      // when nothing is configured so the user has somewhere to start.
      if (ctx.mcpManager.status().size === 0) {
        ctx.addBlock({
          kind: 'slash_output',
          text:
            'MCP servers: (none configured)\n\n' +
            'Add servers to ~/.lcode/mcp.json or .mcp.json at the project root.',
        });
        return;
      }
      ctx.openMcpPicker();
    },
  },
  {
    name: 'exit',
    description: 'Exit lcode.',
    execute: (_args, ctx) => {
      ctx.exit();
    },
  },
];

/**
 * Match a slash query against COMMANDS. Returns commands whose names
 * start with the query (case-insensitive), in registration order.
 */
export function matchCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * Parse the input as a slash command and execute it. Returns true if it
 * was a slash command (handled), false if it should be sent to the LLM.
 */
export async function maybeRunSlashCommand(
  input: string,
  ctx: SlashContext,
): Promise<boolean> {
  if (!input.startsWith('/')) return false;
  const trimmed = input.slice(1).trim();
  if (!trimmed) return true; // bare slash — eat it
  const [name, ...rest] = trimmed.split(/\s+/);
  const args = rest.join(' ');
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) {
    ctx.addBlock({
      kind: 'slash_output',
      text: `Unknown command: /${name}. Type /help for a list.`,
    });
    return true;
  }
  await cmd.execute(args, ctx);
  return true;
}

export function isSlashPopupOpen(input: string): boolean {
  if (!input.startsWith('/')) return false;
  // Once the user is typing args (after a space), the popup hides.
  return !input.slice(1).includes(' ');
}

export function getSlashQuery(input: string): string {
  return (input.slice(1).split(/\s+/)[0] ?? '');
}

const MAX_VISIBLE = 8;

/**
 * Slash command popup. Renders below the input area, replacing the statusline
 * while open. Arrow keys move the selection in App; Enter runs the selected
 * command via App's onSubmit handler.
 */
export function SlashPopup({
  input,
  selectedIdx,
}: {
  input: string;
  selectedIdx: number;
}) {
  if (!isSlashPopupOpen(input)) return null;
  const matches = matchCommands(getSlashQuery(input));
  if (matches.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color="gray">no matching command</Text>
      </Box>
    );
  }

  const nameWidth = Math.max(...matches.map((c) => c.name.length)) + 1;
  const visible = matches.slice(0, MAX_VISIBLE);
  const more = matches.length - visible.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      {visible.map((c, i) => {
        const selected = i === selectedIdx;
        const name = `/${c.name}`.padEnd(nameWidth + 1);
        return (
          <Text key={c.name}>
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {name}
            </Text>
            <Text color="gray"> {c.description}</Text>
          </Text>
        );
      })}
      {more > 0 && (
        <Text color="gray">  …{more} more</Text>
      )}
    </Box>
  );
}
