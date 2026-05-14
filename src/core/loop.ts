import { ZodError } from 'zod';
import type {
  AnthropicMessage,
  ContentBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSubagentProgressMessage,
  SDKSystemInitMessage,
  ToolResultBlock,
  ToolUseBlock,
} from './messages.js';
import { textBlock, toolResultBlock } from './messages.js';
import { RepetitionError, runCompletion, streamLlm, toOpenAITools, type LlmFinalMessage } from './llm.js';
import { debugLog } from './debug-log.js';
import { compact } from './compactor.js';
import { runSubagent } from './agent.js';
import { newSessionId } from './session.js';
import { estimateTokens } from '../tui/tokens.js';
import { newSessionState, type SessionState, type Tool } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildSystemPrompt } from '../prompts/system.js';
import type { ClaudeMdFile } from '../prompts/claudemd.js';
import type { AgentFiles } from '../prompts/agents.js';
import type { Skill } from '../skills/types.js';
import { makeSkillTool } from '../tools/builtin/skill.js';

export interface LoopArgs {
  sessionId: string;
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tools: Tool[];
  customSystemPrompt?: string;
  /**
   * Bypass `buildSystemPrompt` entirely and send this string as the system
   * prompt. Skips agent files, CLAUDE.md, environment, and tool guidance —
   * tool schemas are still attached via the OpenAI `tools[]` field.
   */
  overrideSystemPrompt?: string;
  initialMessages: AnthropicMessage[];
  newUserPrompt: string | ContentBlock[];
  maxTurns: number;
  signal: AbortSignal;
  includePartialMessages: boolean;
  permissionMode?: string;
  sessionState?: SessionState;
  claudeMdFiles?: ClaudeMdFile[];
  /** Resolved agent-identity strings (persona/human/capabilities/instructions). */
  agentFiles?: AgentFiles;
  /**
   * Enabled skills advertised to the model and reachable via the `Skill` tool.
   * The list is consumed once at runLoop entry — the system prompt's
   * "Available Skills" section is built from it and the `Skill` tool is
   * registered with this exact list.
   */
  skills?: Skill[];
  /** Surfaced into ToolContext for WebSearch. */
  searxngUrl?: string;
  /** Window size for the compaction threshold. Falls back to a no-op large value when omitted. */
  contextWindow?: number;
  /** Fraction of contextWindow that triggers auto-compaction. */
  compactThreshold?: number;
  /** Recent user/assistant turn boundaries kept verbatim through tier-2 summarization. */
  compactPreserveTail?: number;
  /** Forwarded to the LLM. Default true. */
  enableThinking?: boolean;
}

export async function* runLoop(args: LoopArgs): AsyncGenerator<SDKMessage> {
  const startedAt = Date.now();
  const registry = new ToolRegistry();
  const baseTools = args.tools.slice();
  // Skill tool is built per-call so its bound name map matches the exact
  // enabled list this turn sees. Skipped when no skills are enabled so the
  // model isn't even aware of the tool's name.
  if (args.skills && args.skills.length > 0) {
    const invocable = args.skills.filter((s) => !s.disableModelInvocation);
    if (invocable.length > 0) baseTools.push(makeSkillTool(invocable));
  }
  const enabledTools = filterToolsForMode(baseTools, args.permissionMode);
  registry.registerAll(enabledTools);

  const init: SDKSystemInitMessage = {
    type: 'system',
    subtype: 'init',
    session_id: args.sessionId,
    cwd: args.cwd,
    model: args.model,
    tools: registry.names(),
    permissionMode: args.permissionMode,
  };
  yield init;

  const sessionState = args.sessionState ?? newSessionState();

  const systemPrompt =
    args.overrideSystemPrompt !== undefined
      ? args.overrideSystemPrompt
      : buildSystemPrompt({
          cwd: args.cwd,
          tools: enabledTools,
          customSystemPrompt: args.customSystemPrompt,
          permissionMode: args.permissionMode,
          claudeMdFiles: args.claudeMdFiles,
          agentFiles: args.agentFiles,
          skills: args.skills,
        });

  // Compaction overhead — system prompt + tool schemas. Computed once
  // because they don't change across the loop's iterations. Used by the
  // compactor to reason about *real* prompt size, not just history.
  const compactOverheadTokens =
    estimateTokens(systemPrompt) +
    (enabledTools.length > 0
      ? estimateTokens(JSON.stringify(toOpenAITools(enabledTools)))
      : 0);

  const userContent: ContentBlock[] =
    typeof args.newUserPrompt === 'string'
      ? [textBlock(args.newUserPrompt)]
      : args.newUserPrompt;

  const history: AnthropicMessage[] = [
    ...args.initialMessages,
    { role: 'user', content: userContent },
  ];

  // Persist the user prompt so resume() rebuilds a continuous history.
  // (Without this, the JSONL has assistant→tool_result→assistant pairs
  // but no record of what the user actually asked.)
  yield {
    type: 'user',
    session_id: args.sessionId,
    message: { role: 'user', content: userContent },
  };

  let numTurns = 0;
  let usageTotal = { input_tokens: 0, output_tokens: 0 };

  // Turn-level tool-loop detector. Local models occasionally pick a single
  // tool call (e.g. an Edit whose `old_string` doesn't match anywhere) and
  // retry it verbatim for dozens of turns. The streamed-content repetition
  // monitor doesn't catch this because the *thinking* between attempts is
  // different — only the tool call itself repeats. Window of the last 3
  // turns' (sorted tool fingerprints, all-failed flag); abort when all
  // three match each other and all calls failed.
  type ToolTurnFingerprint = { fp: string; allErrored: boolean };
  const recentToolTurns: ToolTurnFingerprint[] = [];
  const STUCK_TURN_THRESHOLD = 3;

  for (;;) {
    if (args.signal.aborted) {
      yield buildResult({
        sessionId: args.sessionId,
        subtype: 'error_aborted',
        startedAt,
        numTurns,
        usage: usageTotal,
        error: 'aborted',
      });
      return;
    }
    if (numTurns >= args.maxTurns) {
      yield buildResult({
        sessionId: args.sessionId,
        subtype: 'error_max_turns',
        startedAt,
        numTurns,
        usage: usageTotal,
        error: `max turns (${args.maxTurns}) reached`,
      });
      return;
    }
    numTurns++;

    // Auto-compaction. Cheap when under threshold (one BPE pass over history).
    // We mutate `history` in place via reassignment so subsequent turns see
    // the compacted state, and yield a marker so the caller (query) persists
    // the compaction event into the JSONL for --resume.
    if (args.contextWindow && args.compactThreshold) {
      try {
        const result = await compact(history, {
          contextWindow: args.contextWindow,
          threshold: args.compactThreshold,
          overheadTokens: compactOverheadTokens,
          preserveTail: args.compactPreserveTail ?? 2,
          runCompletion: ({ systemPrompt = '', userPrompt, signal }) =>
            runCompletion({
              baseUrl: args.baseUrl,
              apiKey: args.apiKey,
              model: args.model,
              systemPrompt,
              userPrompt,
              signal: signal ?? args.signal,
            }),
          signal: args.signal,
        });
        if (result.tier !== 'noop') {
          history.length = 0;
          for (const m of result.history) history.push(m);
          yield {
            type: 'compaction',
            session_id: args.sessionId,
            subtype: result.tier,
            saved_tokens: result.savedTokens,
            summary: result.summary,
            truncated_tool_use_ids: result.truncatedToolUseIds,
          };
        }
      } catch (err) {
        // Compaction failures should never crash the agent loop. Surface as
        // an assistant text? No — that'd confuse the model. Just swallow and
        // let the request proceed; if it overflows, the LLM error message
        // will still surface to the user via the normal error path.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(`[lcode] compaction failed: ${msg}`);
      }
    }

    let final: LlmFinalMessage;
    try {
      final = yield* streamWithPartials(
        args,
        registry,
        systemPrompt,
        history,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const subtype: SDKResultMessage['subtype'] = args.signal.aborted
        ? 'error_aborted'
        : err instanceof RepetitionError
          ? 'error_repetition'
          : 'error_llm';
      yield buildResult({
        sessionId: args.sessionId,
        subtype,
        startedAt,
        numTurns,
        usage: usageTotal,
        error: msg,
      });
      return;
    }

    if (final.usage) {
      usageTotal.input_tokens += final.usage.input_tokens;
      usageTotal.output_tokens += final.usage.output_tokens;
    }

    const assistantMsg: SDKAssistantMessage = {
      type: 'assistant',
      session_id: args.sessionId,
      message: {
        role: 'assistant',
        content: final.content,
        model: args.model,
        stop_reason: final.stop_reason,
        usage: final.usage,
      },
    };
    yield assistantMsg;
    history.push({ role: 'assistant', content: final.content });

    const toolUses = final.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      const text = final.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      yield buildResult({
        sessionId: args.sessionId,
        subtype: 'success',
        startedAt,
        numTurns,
        usage: usageTotal,
        result: text,
      });
      return;
    }

    // Sub-agent progress events queued by spawnAgent's onProgress callback.
    // The race loop below yields these out as SDKMessages while still
    // awaiting the parallel tool dispatch promises, so the TUI can render
    // sub-agent activity live.
    const progressQueue: SDKSubagentProgressMessage[] = [];
    let progressNotify: (() => void) | null = null;
    const wakeup = () => {
      const n = progressNotify;
      progressNotify = null;
      n?.();
    };

    const dispatchTool = async (tu: ToolUseBlock): Promise<ToolResultBlock> => {
      if (args.signal.aborted) {
        return toolResultBlock(tu.id, 'aborted', true);
      }
      const tool = registry.get(tu.name);
      if (!tool) {
        return toolResultBlock(
          tu.id,
          `Error: unknown tool "${tu.name}". Available: ${registry.names().join(', ')}`,
          true,
        );
      }
      let parsed: unknown;
      try {
        parsed = tool.inputSchema.parse(tu.input);
      } catch (err) {
        const msg = err instanceof ZodError ? formatZodError(err) : String(err);
        return toolResultBlock(tu.id, `Error: invalid arguments: ${msg}`, true);
      }
      try {
        const result = await tool.handler(parsed, {
          cwd: args.cwd,
          signal: args.signal,
          sessionState,
          searxngUrl: args.searxngUrl,
          runCompletion: ({ systemPrompt = '', userPrompt, signal }) =>
            runCompletion({
              baseUrl: args.baseUrl,
              apiKey: args.apiKey,
              model: args.model,
              systemPrompt,
              userPrompt,
              signal: signal ?? args.signal,
            }),
          spawnAgent: async (req) => {
            // Sub-agent inherits the parent's full toolset (minus Task —
            // no grandchildren) and the parent's verbatim system prompt.
            // We deliberately do NOT expose a tool allowlist on the Task
            // schema: when we did, smaller models filled the field with
            // chat-template-corrupted nonsense and crippled their own
            // sub-agents. Parent parity is the most reliable contract.
            const subTools = enabledTools.filter((t) => t.name !== 'Task');
            return runSubagent({
              cwd: args.cwd,
              baseUrl: args.baseUrl,
              apiKey: args.apiKey,
              model: args.model,
              systemPrompt,
              tools: subTools,
              initialPrompt: req.prompt,
              maxTurns: 15,
              signal: args.signal,
              sessionState: newSessionState(),
              searxngUrl: args.searxngUrl,
              // Persist the sub-agent's full conversation to disk for
              // debugging. Lives at ~/.lcode/projects/<cwd>/subagents/<id>.jsonl.
              sessionId: newSessionId(),
              onProgress: (event) => {
                progressQueue.push({
                  type: 'subagent_progress',
                  session_id: args.sessionId,
                  parent_tool_use_id: tu.id,
                  event,
                });
                wakeup();
              },
            });
          },
        });
        return toolResultBlock(tu.id, result.content, result.isError ?? false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolResultBlock(tu.id, `Error: ${msg}`, true);
      }
    };

    // Dispatch concurrently, but yield progress events as they arrive.
    // Promise.all preserves input order so tool_result blocks stay aligned
    // with their tool_use ids. Each handler captures its own errors, so
    // Promise.all never rejects here.
    const dispatchPromise = Promise.all(toolUses.map(dispatchTool));
    let dispatchDone = false;
    void dispatchPromise.then(() => {
      dispatchDone = true;
      wakeup();
    });

    while (true) {
      while (progressQueue.length > 0) {
        const ev = progressQueue.shift()!;
        yield ev;
      }
      if (dispatchDone) break;
      await new Promise<void>((resolve) => {
        progressNotify = resolve;
      });
    }

    const toolResults = await dispatchPromise;

    yield {
      type: 'user',
      session_id: args.sessionId,
      message: { role: 'user', content: toolResults },
    };
    history.push({ role: 'user', content: toolResults });

    const fp = fingerprintToolCalls(toolUses);
    const allErrored = toolResults.every((r) => r.is_error === true);
    recentToolTurns.push({ fp, allErrored });
    if (recentToolTurns.length > STUCK_TURN_THRESHOLD) recentToolTurns.shift();
    if (
      recentToolTurns.length === STUCK_TURN_THRESHOLD &&
      recentToolTurns.every((t) => t.allErrored && t.fp === fp)
    ) {
      debugLog('tool_loop_detected', { fingerprint: fp, turns: STUCK_TURN_THRESHOLD });
      yield buildResult({
        sessionId: args.sessionId,
        subtype: 'error_repetition',
        startedAt,
        numTurns,
        usage: usageTotal,
        error:
          `Aborted: model called the same tool with the same arguments ${STUCK_TURN_THRESHOLD} ` +
          `turns in a row and every call failed. This usually means the model got stuck and will not recover.`,
      });
      return;
    }
  }
}

export function fingerprintToolCalls(uses: ToolUseBlock[]): string {
  const sorted = [...uses].sort((a, b) =>
    a.name === b.name ? 0 : a.name < b.name ? -1 : 1,
  );
  return JSON.stringify(sorted.map((u) => ({ name: u.name, input: u.input })));
}

async function* streamWithPartials(
  args: LoopArgs,
  registry: ToolRegistry,
  systemPrompt: string,
  history: AnthropicMessage[],
): AsyncGenerator<SDKMessage, LlmFinalMessage, void> {
  const gen = streamLlm({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    systemPrompt,
    messages: history,
    tools: registry.list(),
    signal: args.signal,
    enableThinking: args.enableThinking,
  });
  while (true) {
    const next = await gen.next();
    if (next.done) return next.value;
    if (args.includePartialMessages) {
      yield {
        type: 'partial_assistant',
        session_id: args.sessionId,
        event: next.value,
      };
    }
  }
}

function filterToolsForMode(tools: Tool[], permissionMode?: string): Tool[] {
  if (permissionMode === 'plan') return tools.filter((t) => t.readOnly);
  return tools;
}

function buildResult(args: {
  sessionId: string;
  subtype: SDKResultMessage['subtype'];
  startedAt: number;
  numTurns: number;
  usage: { input_tokens: number; output_tokens: number };
  result?: string;
  error?: string;
}): SDKResultMessage {
  return {
    type: 'result',
    session_id: args.sessionId,
    subtype: args.subtype,
    duration_ms: Date.now() - args.startedAt,
    num_turns: args.numTurns,
    total_cost_usd: 0,
    usage: args.usage,
    result: args.result,
    error: args.error,
  };
}

function formatZodError(err: ZodError): string {
  return err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
}

// avoid unused-import warning when ContentBlock isn't directly referenced
export type { ContentBlock };
