import { ZodError } from 'zod';
import type {
  AnthropicMessage,
  SDKMessage,
  SubagentProgressEvent,
  ToolResultBlock,
  ToolUseBlock,
} from './messages.js';
import { textBlock, toolResultBlock } from './messages.js';
import { streamLlm, type LlmFinalMessage } from './llm.js';
import { appendMessage, openSession, type Session } from './session.js';
import { newSessionState, type SessionState, type Tool } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';

export type SubagentStopReason = 'success' | 'max_turns' | 'aborted' | 'error';

export interface RunSubagentArgs {
  cwd: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  tools: Tool[];
  initialPrompt: string;
  maxTurns: number;
  signal: AbortSignal;
  sessionState?: SessionState;
  searxngUrl?: string;
  /**
   * Optional progress callback invoked at each meaningful step (init,
   * tool_use, tool_result). The parent loop wires this to a queue that
   * surfaces SDKSubagentProgressMessages so the TUI can render the
   * sub-agent's activity live under its parent Task tool_call block.
   */
  onProgress?: (event: SubagentProgressEvent) => void;
  /**
   * If provided, persist the sub-agent's full conversation to a JSONL
   * file under `~/.lcode/projects/<cwd>/subagents/<sessionId>.jsonl`.
   * Mirrors the parent's session shape so the two can be diff'd to
   * diagnose model behavior differences.
   */
  sessionId?: string;
}

export interface SubagentResult {
  finalText: string;
  numTurns: number;
  /** Total number of tool_use blocks the sub-agent issued across all turns. */
  toolUseCount: number;
  /** Sum of input + output tokens reported by the LLM across all turns. */
  totalTokens: number;
  /** Wall-clock duration of the sub-agent run in milliseconds. */
  elapsedMs: number;
  stopReason: SubagentStopReason;
  /**
   * Persistent session ID, when persistence was enabled. Surfaced to the
   * caller so it can be included in the Task tool's metadata header,
   * letting users locate the sub-agent's JSONL for debugging.
   */
  sessionId?: string;
}

/**
 * Run an isolated sub-agent loop to completion and return its final text.
 *
 * Distinct from `runLoop`: no SDKMessage emission, no streaming partial
 * events, no session JSONL persistence, no auto-compaction. This is
 * intentional — the sub-agent is a one-shot worker whose intermediate
 * tool calls and reasoning stay opaque to the parent. The parent sees
 * only the final summarized response in a single tool_result block.
 *
 * Sub-agents do NOT receive `runCompletion` or `spawnAgent` in their
 * tool context (no grandchildren), keeping the hierarchy flat.
 */
export async function runSubagent(args: RunSubagentArgs): Promise<SubagentResult> {
  const startedAt = Date.now();
  const registry = new ToolRegistry();
  registry.registerAll(args.tools);
  const sessionState = args.sessionState ?? newSessionState();

  // Persist the sub-agent's conversation to its own JSONL when sessionId
  // is provided. Mirrors the parent's session shape so the two files can
  // be diff'd directly to diagnose differences in model behavior.
  const sid = args.sessionId ?? '';
  let session: Session | null = null;
  if (args.sessionId) {
    session = await openSession(args.sessionId, args.cwd, 'subagents');
  }
  const persist = async (msg: SDKMessage) => {
    if (session) await appendMessage(session, msg);
  };

  const history: AnthropicMessage[] = [
    { role: 'user', content: [textBlock(args.initialPrompt)] },
  ];

  await persist({
    type: 'system',
    subtype: 'init',
    session_id: sid,
    cwd: args.cwd,
    model: args.model,
    tools: args.tools.map((t) => t.name),
  });
  await persist({
    type: 'user',
    session_id: sid,
    message: { role: 'user', content: [textBlock(args.initialPrompt)] },
  });

  // Tell the TUI we've started — used to switch the parent's Task block
  // from the generic "Running…" indicator to "Initializing…" until the
  // first tool_use event arrives (or the sub-agent finishes without any).
  args.onProgress?.({ kind: 'init' });

  let lastText = '';
  let toolUseCount = 0;
  let totalTokens = 0;

  const buildResult = async (
    text: string,
    numTurns: number,
    stopReason: SubagentStopReason,
  ): Promise<SubagentResult> => {
    const elapsedMs = Date.now() - startedAt;
    await persist({
      type: 'result',
      session_id: sid,
      subtype:
        stopReason === 'success'
          ? 'success'
          : stopReason === 'max_turns'
            ? 'error_max_turns'
            : stopReason === 'aborted'
              ? 'error_aborted'
              : 'error_llm',
      duration_ms: elapsedMs,
      num_turns: numTurns,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: totalTokens },
      result: text,
    });
    return {
      finalText: text,
      numTurns,
      toolUseCount,
      totalTokens,
      elapsedMs,
      stopReason,
      sessionId: args.sessionId,
    };
  };

  for (let turn = 0; turn < args.maxTurns; turn++) {
    if (args.signal.aborted) {
      return await buildResult(lastText || '[aborted]', turn, 'aborted');
    }

    let final: LlmFinalMessage;
    try {
      // No maxTokens here — match the parent's call exactly. Repetition
      // detection + maxTurns are sufficient safeguards on their own.
      // Forward text deltas through onProgress so the TUI can show what
      // the sub-agent is generating instead of just sitting on
      // "Initializing…" for the duration of the LLM call.
      final = await consumeStreamWithProgress(
        streamLlm({
          baseUrl: args.baseUrl,
          apiKey: args.apiKey,
          model: args.model,
          systemPrompt: args.systemPrompt,
          messages: history,
          tools: registry.list(),
          signal: args.signal,
        }),
        args.onProgress,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return await buildResult(`[sub-agent LLM error: ${msg}]`, turn, 'error');
    }
    args.onProgress?.({ kind: 'turn_end' });

    if (final.usage) {
      totalTokens += final.usage.input_tokens + final.usage.output_tokens;
    }

    history.push({ role: 'assistant', content: final.content });
    await persist({
      type: 'assistant',
      session_id: sid,
      message: {
        role: 'assistant',
        content: final.content,
        model: args.model,
        stop_reason: final.stop_reason,
        usage: final.usage,
      },
    });

    const toolUses = final.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    const text = final.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (text) lastText = text;

    if (toolUses.length === 0) {
      // Detect degenerate output: the model produced text that LOOKS like
      // tool calls (`call:bash{...}` notation, leaked `<|tool_response>`
      // markers) but didn't use the structured tools API. Returning that
      // as success would dump the garbage into the parent's context.
      if (looksLikeMalformedToolCalls(text)) {
        const sample = text.length > 800 ? text.slice(0, 800) + '\n[...truncated]' : text;
        return await buildResult(
          '[sub-agent failed: model emitted malformed text-mode tool calls instead of using ' +
          "the tools API. Try a smaller, more specific prompt or use the parent agent's tools " +
          `directly.]\n\nModel output (for diagnosis):\n${sample}`,
          turn + 1,
          'error',
        );
      }
      return await buildResult(text, turn + 1, 'success');
    }

    toolUseCount += toolUses.length;
    for (const tu of toolUses) {
      args.onProgress?.({
        kind: 'tool_use',
        id: tu.id,
        name: tu.name,
        input: tu.input,
      });
    }
    const toolResults = await Promise.all(
      toolUses.map((tu) => dispatchSubagentTool(tu, registry, args, sessionState)),
    );
    for (const tr of toolResults) {
      args.onProgress?.({
        kind: 'tool_result',
        tool_use_id: tr.tool_use_id,
        isError: tr.is_error ?? false,
      });
    }

    history.push({ role: 'user', content: toolResults });
    await persist({
      type: 'user',
      session_id: sid,
      message: { role: 'user', content: toolResults },
    });
  }

  return await buildResult(
    lastText || '[sub-agent exhausted max turns]',
    args.maxTurns,
    'max_turns',
  );
}

async function consumeStreamWithProgress(
  gen: ReturnType<typeof streamLlm>,
  onProgress: ((event: SubagentProgressEvent) => void) | undefined,
): Promise<LlmFinalMessage> {
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
    // Forward visible text deltas only. Skip thinking/tool_use partials —
    // thinking is internal noise, tool_use partials would emit duplicate
    // events alongside the post-stream `tool_use` events runSubagent
    // emits explicitly with parsed inputs.
    if (onProgress && next.value.kind === 'text_delta') {
      onProgress({ kind: 'text_delta', text: next.value.text });
    }
  }
}

/**
 * Heuristic for detecting when a local model emitted text that mimics tool
 * calls (e.g. `call:bash{command: "ls"}`, leaked `<|tool_response>` tokens,
 * or hallucinated tool responses) instead of using the structured
 * `tool_calls` field. Tripping this means the sub-agent's output is almost
 * certainly degenerate and should not be surfaced to the parent as success.
 *
 * Bias: false negatives are worse than false positives in subagent context.
 * A real subagent answer rarely contains shell-syntax `call:foo{...}`
 * snippets; the patterns we look for are specific enough that legit prose
 * very rarely trips them.
 */
function looksLikeMalformedToolCalls(text: string): boolean {
  if (text.length === 0) return false;
  // Harmony tool markers leaking through (noise filter strips known forms;
  // anything that survives here — including newline-split `<|thought\n|>`
  // variants — is a strong signal of a degenerate generation).
  if (/<\|?tool_(?:call|response)\|?>/.test(text)) return true;
  if (/<\|?(?:thought|channel|message)\b[\s\S]{0,8}\|?>/.test(text)) return true;
  // Text-mode tool call notation. Tolerates separators between name and `{`:
  //   call:bash{command: "ls"}        — direct
  //   call:glob:{"pattern":"..."}     — colon separator
  //   call:Read({"file_path":"..."})  — paren-wrapped
  if (/\bcall:[a-zA-Z_]{2,}\s*[:\s(]?\s*\{/.test(text)) return true;
  // Hallucinated tool response: the model invented a JSON-looking response
  // payload. Common shape: `}}[{"output":"..."}]`. The double brace +
  // output-key combo doesn't appear in normal prose.
  if (/\}\s*\}\s*\[\s*\{\s*"(?:output|result|content)"\s*:/.test(text)) return true;
  // Degenerate repetition. Sample windows from the start of `text` and
  // count their occurrences; any 25-char chunk repeating 4+ times means
  // the model is stuck in a generation loop.
  if (hasRepetition(text)) return true;
  return false;
}

function hasRepetition(text: string, chunkLen = 25, threshold = 4): boolean {
  if (text.length < chunkLen * threshold) return false;
  // Sample at strided positions in the first 400 chars — far cheaper than
  // checking every window, and a degenerate loop produces a chunk that
  // also appears near the start.
  const limit = Math.min(text.length - chunkLen, 400);
  for (let i = 0; i < limit; i += 5) {
    const chunk = text.slice(i, i + chunkLen);
    if (!/[a-zA-Z]/.test(chunk)) continue; // skip whitespace-only chunks
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = text.indexOf(chunk, pos);
      if (idx < 0) break;
      count++;
      if (count >= threshold) return true;
      pos = idx + 1;
    }
  }
  return false;
}

async function dispatchSubagentTool(
  tu: ToolUseBlock,
  registry: ToolRegistry,
  args: RunSubagentArgs,
  sessionState: SessionState,
): Promise<ToolResultBlock> {
  if (args.signal.aborted) return toolResultBlock(tu.id, 'aborted', true);
  const tool = registry.get(tu.name);
  if (!tool) {
    return toolResultBlock(
      tu.id,
      `Error: unknown tool "${tu.name}" in sub-agent. Available: ${registry.names().join(', ')}`,
      true,
    );
  }
  let parsed: unknown;
  try {
    parsed = tool.inputSchema.parse(tu.input);
  } catch (err) {
    const msg = err instanceof ZodError
      ? err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
      : String(err);
    return toolResultBlock(tu.id, `Error: invalid arguments: ${msg}`, true);
  }
  try {
    // Sub-agent ToolContext: no `runCompletion` (would re-enter the model
    // wastefully) and no `spawnAgent` (no grandchildren — flat hierarchy).
    const result = await tool.handler(parsed, {
      cwd: args.cwd,
      signal: args.signal,
      sessionState,
      searxngUrl: args.searxngUrl,
    });
    return toolResultBlock(tu.id, result.content, result.isError ?? false);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolResultBlock(tu.id, `Error: ${msg}`, true);
  }
}
