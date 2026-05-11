import type { LcodeConfig } from '../config.js';
import { loadConfig } from '../config.js';
import type { SdkMcpServerConfig, Tool } from '../tools/types.js';
import { newSessionState } from '../tools/types.js';
import { BUILTIN_TOOLS } from '../tools/builtin/index.js';
import { loadClaudeMdFiles, type ClaudeMdFile } from '../prompts/claudemd.js';
import { loadAgentFiles, type AgentFiles } from '../prompts/agents.js';
import { loadMcpServers } from '../mcp/config.js';
import { McpManager } from '../mcp/manager.js';
import type { McpServerConfig } from '../mcp/types.js';
import type { AnthropicMessage, ContentBlock, SDKMessage } from './messages.js';
import { replayHistoryForCompact } from './compactor.js';
import { runLoop } from './loop.js';
import {
  appendMessage,
  loadSessionMessages,
  newSessionId,
  openSession,
} from './session.js';

export interface QueryOptions {
  /**
   * The user prompt for this turn. A plain string takes the legacy
   * text-only path. Pass `ContentBlock[]` (text + image blocks) to send
   * multimodal content to the LLM — the TUI builds this when the user
   * pastes images.
   */
  prompt: string | ContentBlock[];
  cwd?: string;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  abortController?: AbortController;
  resume?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  /**
   * Programmatic MCP server configurations. Mixed types accepted:
   *   - `SdkMcpServerConfig`: inline tool list (no protocol connection)
   *   - `McpServerConfig` (stdio | http | sse): real MCP server connected on demand
   * In addition, lcode discovers servers from `~/.lcode/mcp.json`,
   * `.mcp.json` at the project root, and `~/.claude.json`'s `mcpServers`.
   * Set `loadMcpFromConfigFiles: false` to skip file-based discovery.
   */
  mcpServers?: (SdkMcpServerConfig | McpServerConfig)[];
  /** Skip the file-based MCP discovery; only use `mcpServers`. Default: discover. */
  loadMcpFromConfigFiles?: boolean;
  /** Reuse a pre-started McpManager (e.g. one shared by the TUI across queries). */
  mcpManager?: McpManager;
  includePartialMessages?: boolean;
  /** Override the LLM endpoint config (otherwise loaded from env). */
  config?: Partial<LcodeConfig>;
  /**
   * Pre-loaded CLAUDE.md files. If undefined, lcode auto-discovers them
   * from cwd (user-level + walk-up to project root). Pass an explicit
   * value to cache across multiple `query()` calls in the same session.
   */
  claudeMdFiles?: ClaudeMdFile[];
  /**
   * Pre-resolved agent-identity strings (persona/human/capabilities/instructions).
   * If undefined, lcode reads `~/.lcode/settings.json` and the configured
   * `~/.lcode/*.md` files. Pass an explicit value to skip file IO.
   */
  agentFiles?: AgentFiles;
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
    compactThreshold: options.config?.compactThreshold ?? baseConfig.compactThreshold,
    searxngUrl: options.config?.searxngUrl ?? baseConfig.searxngUrl,
  };

  const cwd = options.cwd ?? process.cwd();
  const sessionId = options.resume ?? newSessionId();
  const session = await openSession(sessionId, cwd);

  const { initialMessages, replayedSessionState } = options.resume
    ? await replayHistory(sessionId, cwd)
    : { initialMessages: [] as AnthropicMessage[], replayedSessionState: newSessionState() };

  // Resolve MCP tools. Caller-supplied manager wins (so the TUI can share a
  // single manager across queries). Otherwise: discover from files + merge in
  // protocol-typed entries from `mcpServers`, then connect for the duration
  // of this query. Inline `SdkMcpServerConfig` entries flatten into builtins.
  const protocolConfigs = pickProtocolConfigs(options.mcpServers);
  const inlineSdkConfigs = pickSdkConfigs(options.mcpServers);

  const ownsManager = !options.mcpManager;
  // For ephemeral managers created here we only need the configs themselves —
  // the source paths surfaced by `loadMcpServers` are only used by the TUI's
  // /mcp picker, which is owned by the long-lived manager in App.
  const fileConfigs =
    ownsManager && options.loadMcpFromConfigFiles !== false
      ? (await loadMcpServers(cwd)).map((e) => e.config)
      : [];
  const allProtocolConfigs = mergeByName(fileConfigs, protocolConfigs);

  const manager =
    options.mcpManager ?? new McpManager(allProtocolConfigs);
  if (ownsManager) await manager.start();

  const tools = collectTools(options, manager.tools(), inlineSdkConfigs);

  const claudeMdFiles =
    options.claudeMdFiles ?? (await loadClaudeMdFiles(cwd));

  const agentFiles = options.agentFiles ?? (await loadAgentFiles());

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
    agentFiles,
    searxngUrl: config.searxngUrl,
    contextWindow: config.contextWindow,
    compactThreshold: config.compactThreshold,
  });

  try {
    for await (const msg of generator) {
      if (msg.type !== 'partial_assistant') {
        await appendMessage(session, msg);
      }
      yield msg;
    }
  } finally {
    if (ownsManager) await manager.close();
  }
}

function collectTools(
  options: QueryOptions,
  fromMcpManager: Tool[],
  fromInlineSdk: SdkMcpServerConfig[],
): Tool[] {
  const fromBuiltins = BUILTIN_TOOLS;
  const fromInline = fromInlineSdk.flatMap((s) => s.tools);
  const all = [...fromBuiltins, ...fromInline, ...fromMcpManager];
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

function pickProtocolConfigs(
  servers: QueryOptions['mcpServers'],
): McpServerConfig[] {
  if (!servers) return [];
  return servers.filter(
    (s): s is McpServerConfig => s.type !== 'sdk',
  );
}

function pickSdkConfigs(
  servers: QueryOptions['mcpServers'],
): SdkMcpServerConfig[] {
  if (!servers) return [];
  return servers.filter(
    (s): s is SdkMcpServerConfig => s.type === 'sdk',
  );
}

/**
 * Merge two lists of MCP server configs by name. The first list takes
 * precedence on conflict — used to give programmatic configs higher priority
 * than file-based ones.
 */
function mergeByName(
  base: McpServerConfig[],
  override: McpServerConfig[],
): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const c of base) byName.set(c.name, c);
  for (const c of override) byName.set(c.name, c);
  return [...byName.values()];
}

async function replayHistory(
  sessionId: string,
  cwd: string,
): Promise<{ initialMessages: AnthropicMessage[]; replayedSessionState: ReturnType<typeof newSessionState> }> {
  const messages = await loadSessionMessages(sessionId, cwd);
  const initialMessages = replayHistoryForCompact(messages);
  const sessionState = newSessionState();
  // Replay file reads so Edit's "must Read first" rule survives resume.
  // We can't reconstruct exact paths from tool_results without parsing;
  // a simpler approximation: scan tool_use inputs for file_path keys.
  for (const m of messages) {
    if (m.type !== 'assistant') continue;
    for (const block of m.message.content) {
      if (block.type === 'tool_use' && block.name === 'Read') {
        const fp = (block.input as { file_path?: unknown }).file_path;
        if (typeof fp === 'string') sessionState.readFiles.add(fp);
      }
    }
  }
  return { initialMessages, replayedSessionState: sessionState };
}
