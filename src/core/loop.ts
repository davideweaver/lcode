import { ZodError } from 'zod';
import type {
  AnthropicMessage,
  ContentBlock,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemInitMessage,
  ToolResultBlock,
  ToolUseBlock,
} from './messages.js';
import { textBlock, toolResultBlock } from './messages.js';
import { streamLlm, type LlmFinalMessage } from './llm.js';
import { newSessionState, type SessionState, type Tool } from '../tools/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { buildSystemPrompt } from '../prompts/system.js';
import type { ClaudeMdFile } from '../prompts/claudemd.js';

export interface LoopArgs {
  sessionId: string;
  cwd: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  tools: Tool[];
  customSystemPrompt?: string;
  initialMessages: AnthropicMessage[];
  newUserPrompt: string;
  maxTurns: number;
  signal: AbortSignal;
  includePartialMessages: boolean;
  permissionMode?: string;
  sessionState?: SessionState;
  claudeMdFiles?: ClaudeMdFile[];
}

export async function* runLoop(args: LoopArgs): AsyncGenerator<SDKMessage> {
  const startedAt = Date.now();
  const registry = new ToolRegistry();
  const enabledTools = filterToolsForMode(args.tools, args.permissionMode);
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

  const systemPrompt = buildSystemPrompt({
    cwd: args.cwd,
    tools: enabledTools,
    customSystemPrompt: args.customSystemPrompt,
    permissionMode: args.permissionMode,
    claudeMdFiles: args.claudeMdFiles,
  });

  const history: AnthropicMessage[] = [
    ...args.initialMessages,
    { role: 'user', content: [textBlock(args.newUserPrompt)] },
  ];

  // Persist the user prompt so resume() rebuilds a continuous history.
  // (Without this, the JSONL has assistant→tool_result→assistant pairs
  // but no record of what the user actually asked.)
  yield {
    type: 'user',
    session_id: args.sessionId,
    message: { role: 'user', content: [textBlock(args.newUserPrompt)] },
  };

  let numTurns = 0;
  let usageTotal = { input_tokens: 0, output_tokens: 0 };

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
      yield buildResult({
        sessionId: args.sessionId,
        subtype: args.signal.aborted ? 'error_aborted' : 'error_llm',
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
        });
        return toolResultBlock(tu.id, result.content, result.isError ?? false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return toolResultBlock(tu.id, `Error: ${msg}`, true);
      }
    };

    // Dispatch all tool_use blocks concurrently. Promise.all preserves input
    // order, which keeps tool_result blocks aligned with their tool_use ids
    // for the next prompt. Each handler captures its own errors above, so
    // Promise.all never rejects here.
    const toolResults = await Promise.all(toolUses.map(dispatchTool));

    yield {
      type: 'user',
      session_id: args.sessionId,
      message: { role: 'user', content: toolResults },
    };
    history.push({ role: 'user', content: toolResults });
  }
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
