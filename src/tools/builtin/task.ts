import { z } from 'zod';
import { tool } from '../helper.js';

// Schema kept deliberately minimal. We previously exposed a `tools`
// allowlist field, but local models (gemma4) fill it in unprompted with
// chat-template-corrupted strings like `[<|"|>Read<|"|>]`, which after
// cleanup leaves the sub-agent with one tool and no way to discover
// files. The sub-agent then loops on guessed paths. Removing the field
// means the sub-agent always inherits the parent's full toolset and
// can do real work.
const schema = z.object({
  description: z
    .string()
    .max(120)
    .optional()
    .describe('Short label for the sub-agent task. Shown in the TUI; optional.'),
  prompt: z
    .string()
    .min(1)
    .describe(
      "The sub-agent's instruction. Be specific — the sub-agent has a fresh " +
      "context and only sees this prompt. It has access to the same tools " +
      "as the parent agent (Read, Glob, Grep, Bash, Edit, Write, WebFetch, " +
      "WebSearch, plus any MCP tools).",
    ),
});

export const TaskTool = tool(
  'Task',
  'Spawn an isolated sub-agent to execute an exploratory task with its own ' +
    'fresh context. Use for searches and file investigations whose ' +
    'intermediate output you do not want polluting the main conversation. ' +
    "The sub-agent's tool calls and reasoning stay opaque; you receive only " +
    "the sub-agent's final summarized response in a single tool_result.",
  schema,
  async (input, ctx) => {
    if (!ctx.spawnAgent) {
      return {
        content:
          'Task tool unavailable: sub-agents cannot spawn grandchildren. ' +
          'Use the regular tools directly.',
        isError: true,
      };
    }
    const description = input.description?.trim() || deriveDescription(input.prompt);
    try {
      const result = await ctx.spawnAgent({
        description,
        prompt: input.prompt,
      });
      // Prepend a metadata marker line that the TUI parses out for the
      // "Done (N tool uses · X tokens · Ys)" summary header, then strips
      // before display. The model still sees the prefix, which is fine —
      // it's a useful informational signal about the sub-agent's effort.
      const meta = formatMetaLine(result);
      const body = result.finalText.trim();
      const content = `${meta}\n\n${body}`;
      if (result.stopReason === 'success') {
        return { content };
      }
      return {
        content: `${meta} [stopped: ${result.stopReason}]\n\n${body}`,
        isError: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Sub-agent failed: ${msg}`, isError: true };
    }
  },
  // Not readOnly: Task can run any tool the parent permits via allowlist,
  // including write-capable ones. Default allowlist is read-only though.
  { readOnly: false },
);

function deriveDescription(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0]?.trim() ?? 'subagent task';
  return firstLine.length > 80 ? firstLine.slice(0, 79) + '…' : firstLine;
}

const META_PREFIX = '[lcode-task]';

function formatMetaLine(result: {
  toolUseCount: number;
  totalTokens: number;
  elapsedMs: number;
  numTurns: number;
  sessionId?: string;
}): string {
  const tokens =
    result.totalTokens >= 1000
      ? `${(result.totalTokens / 1000).toFixed(1)}k tokens`
      : `${result.totalTokens} tokens`;
  const seconds = (result.elapsedMs / 1000).toFixed(0);
  const uses = `${result.toolUseCount} tool use${result.toolUseCount === 1 ? '' : 's'}`;
  const sessionTag = result.sessionId ? ` · session=${result.sessionId.slice(0, 8)}` : '';
  return `${META_PREFIX} Done (${uses} · ${tokens} · ${seconds}s${sessionTag})`;
}

/** Exported so the TUI's tool_call renderer can detect Task outputs. */
export const TASK_META_PREFIX = META_PREFIX;
