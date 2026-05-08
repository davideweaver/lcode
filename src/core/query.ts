import type { LcodeConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { SdkMcpServerConfig, Tool } from '../tools/types.js';
import { newSessionState } from '../tools/types.js';
import { BUILTIN_TOOLS } from '../tools/builtin/index.js';
import { loadClaudeMdFiles, type ClaudeMdFile } from '../prompts/claudemd.js';
import type { AnthropicMessage, SDKMessage } from './messages.js';
import { runLoop } from './loop.js';
import {
  appendMessage,
  loadSessionMessages,
  newSessionId,
  openSession,
} from './session.js';

export interface QueryOptions {
  prompt: string;
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  abortController?: AbortController;
  resume?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  mcpServers?: SdkMcpServerConfig[];
  includePartialMessages?: boolean;
  /** Override the LLM endpoint config (otherwise loaded from env). */
  config?: Partial<LcodeConfig>;
  /**
   * Pre-loaded CLAUDE.md files. If undefined, lcode auto-discovers them
   * from cwd (user-level + walk-up to project root). Pass an explicit
   * value to cache across multiple `query()` calls in the same session.
   */
  claudeMdFiles?: ClaudeMdFile[];
}

const DEFAULT_MAX_TURNS = 50;

/**
 * Public entry point. Mirrors @anthropic-ai/claude-agent-sdk's `query()`
 * shape closely enough that consumers can swap providers without rewriting.
 */
export async function* query(options: QueryOptions): AsyncGenerator<SDKMessage> {
  const baseConfig = loadConfig();
  const config: LcodeConfig = {
    llmUrl: options.config?.llmUrl ?? baseConfig.llmUrl,
    model: options.model ?? options.config?.model ?? baseConfig.model,
    apiKey: options.config?.apiKey ?? baseConfig.apiKey,
    contextWindow: options.config?.contextWindow ?? baseConfig.contextWindow,
    searxngUrl: options.config?.searxngUrl ?? baseConfig.searxngUrl,
  };

  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.resume ?? newSessionId();
  const session = await openSession(sessionId, cwd);

  const { initialMessages, replayedSessionState } = options.resume
    ? await replayHistory(sessionId, cwd)
    : { initialMessages: [] as AnthropicMessage[], replayedSessionState: newSessionState() };

  const tools = collectTools(options);

  const claudeMdFiles =
    options.claudeMdFiles ?? (await loadClaudeMdFiles(cwd));

  const abortController = options.abortController ?? new AbortController();

  const generator = runLoop({
    sessionId,
    cwd,
    model: config.model,
    baseUrl: config.llmUrl,
    apiKey: config.apiKey,
    tools,
    customSystemPrompt: options.systemPrompt,
    initialMessages,
    newUserPrompt: options.prompt,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    signal: abortController.signal,
    includePartialMessages: options.includePartialMessages ?? false,
    permissionMode: options.permissionMode,
    sessionState: replayedSessionState,
    claudeMdFiles,
    searxngUrl: config.searxngUrl,
  });

  for await (const msg of generator) {
    if (msg.type !== 'partial_assistant') {
      await appendMessage(session, msg);
    }
    yield msg;
  }
}

function collectTools(options: QueryOptions): Tool[] {
  const fromBuiltins = BUILTIN_TOOLS;
  const fromMcp = (options.mcpServers ?? []).flatMap((s) => s.tools);
  const all = [...fromBuiltins, ...fromMcp];
  // dedupe by name (last wins)
  const byName = new Map<string, Tool>();
  for (const t of all) byName.set(t.name, t);
  let filtered = [...byName.values()];
  if (options.allowedTools && options.allowedTools.length > 0) {
    const allow = new Set(options.allowedTools);
    filtered = filtered.filter((t) => allow.has(t.name));
  }
  if (options.disallowedTools && options.disallowedTools.length > 0) {
    const deny = new Set(options.disallowedTools);
    filtered = filtered.filter((t) => !deny.has(t.name));
  }
  return filtered;
}

async function replayHistory(
  sessionId: string,
  cwd: string,
): Promise<{ initialMessages: AnthropicMessage[]; replayedSessionState: ReturnType<typeof newSessionState> }> {
  const messages = await loadSessionMessages(sessionId, cwd);
  const out: AnthropicMessage[] = [];
  const sessionState = newSessionState();
  for (const m of messages) {
    if (m.type === 'assistant') {
      out.push({ role: 'assistant', content: m.message.content });
    } else if (m.type === 'user') {
      out.push({ role: 'user', content: m.message.content });
    }
    // Replay file reads so Edit's "must Read first" rule survives resume.
    // We can't reconstruct exact paths from tool_results without parsing;
    // a simpler approximation: scan tool_use inputs for file_path keys.
    if (m.type === 'assistant') {
      for (const block of m.message.content) {
        if (block.type === 'tool_use' && block.name === 'Read') {
          const fp = (block.input as { file_path?: unknown }).file_path;
          if (typeof fp === 'string') sessionState.readFiles.add(fp);
        }
      }
    }
  }
  return { initialMessages: out, replayedSessionState: sessionState };
}
