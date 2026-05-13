import { Box, Text } from 'ink';
import type { LcodeConfig } from '../config.js';
import type { McpManager } from '../mcp/manager.js';
import { renderSkillBody } from '../skills/render.js';
import type { Skill } from '../skills/types.js';
import type { UiBlock } from './types.js';

export interface SlashContext {
  cwd: string;
  config: LcodeConfig;
  /**
   * Effective context window in tokens — the live value probed from the
   * LLM server, falling back to `config.contextWindow`. Use this (not
   * `config.contextWindow`) when reporting the active window to the user.
   */
  contextWindow: number;
  sessionId?: string;
  currentModel: string;
  setCurrentModel: (model: string) => void;
  addBlock: (block: UiBlock) => void;
  clearSession: () => void;
  openResumePicker: () => void;
  openModelPicker: () => void;
  openMcpPicker: () => void;
  openContextPicker: () => void;
  openSkillsPicker: () => void;
  /** Full discovered skill list (used by /skills and the fallback dispatcher). */
  skills: Skill[];
  /** Names of skills currently enabled for this project. */
  enabledSkillNames: Set<string>;
  /**
   * Inject a user-role prompt into the conversation. Used by the slash
   * dispatcher to fire a skill's rendered SKILL.md body as a synthetic
   * user turn. Pass `displayBlock` to replace the default `user_prompt`
   * UI block — e.g. a `skill_use` summary so the rendered body isn't
   * shown verbatim in the transcript.
   */
  sendUserPrompt: (text: string, displayBlock?: UiBlock) => void;
  /**
   * Force-compact the current session. Loads the JSONL, runs the compactor
   * with `force: true`, appends a marker. Emits a `compaction` block on
   * success and a `slash_output` block describing the outcome.
   */
  runCompactNow: () => Promise<void>;
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
      const { llmUrl } = ctx.config;
      const { contextWindow } = ctx;
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
    name: 'context',
    description: 'Show how the context window is being spent.',
    execute: (_args, ctx) => {
      ctx.openContextPicker();
    },
  },
  {
    name: 'skills',
    description: 'Browse discovered skills. Enable/disable per project.',
    execute: (_args, ctx) => {
      ctx.openSkillsPicker();
    },
  },
  {
    name: 'compact',
    description: 'Free up context: truncate old tool results, summarize if still over.',
    execute: async (_args, ctx) => {
      await ctx.runCompactNow();
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
 * Match a slash query against COMMANDS and (enabled, user-invocable) skills.
 * Returns matches whose names start with the query (case-insensitive).
 * Built-ins come first, then skills.
 */
export function matchCommands(
  query: string,
  skills: Skill[] = [],
  enabled: Set<string> = new Set(),
): SlashCommand[] {
  const q = query.toLowerCase();
  const builtins = COMMANDS.filter((c) => c.name.toLowerCase().startsWith(q));
  const builtinNames = new Set(builtins.map((c) => c.name));
  const skillEntries = skills
    .filter((s) => enabled.has(s.name) && s.userInvocable !== false)
    .filter((s) => !builtinNames.has(s.name))
    .filter((s) => s.name.toLowerCase().startsWith(q))
    .map((s) => skillAsCommand(s));
  return [...builtins, ...skillEntries];
}

function skillAsCommand(skill: Skill): SlashCommand {
  return {
    name: skill.name,
    description: skill.description || '(skill)',
    execute: (args, ctx) => {
      ctx.sendUserPrompt(buildSkillInvocationMessage(skill, args), {
        kind: 'skill_use',
        skillName: skill.name,
        args,
      });
    },
  };
}

/**
 * Wrap the rendered SKILL.md body with an explicit provenance line so the
 * model understands the body has already been loaded for it — and doesn't
 * call the Skill tool a second time to "properly invoke" the same skill.
 * Without this, small/medium models tend to re-invoke and the body shows
 * up twice in the transcript.
 */
function buildSkillInvocationMessage(skill: Skill, args: string): string {
  const argHint = args ? ` with args: "${args}"` : '';
  return [
    `The "${skill.name}" skill was invoked by the user${argHint}. The following are its instructions — follow them directly. Do not call the Skill tool to invoke it again.`,
    '',
    renderSkillBody(skill, args),
  ].join('\n');
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
  if (cmd) {
    await cmd.execute(args, ctx);
    return true;
  }
  // Skill fallback: enabled, user-invocable skills can be fired as /<name>.
  const skill = ctx.skills.find((s) => s.name === name && s.userInvocable !== false);
  if (skill && ctx.enabledSkillNames.has(skill.name)) {
    ctx.sendUserPrompt(buildSkillInvocationMessage(skill, args), {
      kind: 'skill_use',
      skillName: skill.name,
      args,
    });
    return true;
  }
  if (skill) {
    ctx.addBlock({
      kind: 'slash_output',
      text: `Skill '${skill.name}' is disabled. Run /skills to enable it.`,
    });
    return true;
  }
  ctx.addBlock({
    kind: 'slash_output',
    text: `Unknown command: /${name}. Type /help for a list.`,
  });
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
  skills = [],
  enabledSkillNames = new Set(),
}: {
  input: string;
  selectedIdx: number;
  skills?: Skill[];
  enabledSkillNames?: Set<string>;
}) {
  if (!isSlashPopupOpen(input)) return null;
  const matches = matchCommands(getSlashQuery(input), skills, enabledSkillNames);
  const builtinNames = new Set(COMMANDS.map((c) => c.name));
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
        const isSkill = !builtinNames.has(c.name);
        return (
          <Text key={c.name}>
            <Text color={selected ? 'cyan' : undefined} bold={selected}>
              {name}
            </Text>
            <Text color="gray"> {c.description}</Text>
            {isSkill && <Text color="gray"> [skill]</Text>}
          </Text>
        );
      })}
      {more > 0 && (
        <Text color="gray">  …{more} more</Text>
      )}
    </Box>
  );
}
