import { z } from 'zod';
import type { Tool } from '../tools/types.js';
import { connectMcpServer, type McpClient, type McpToolDef } from './client.js';
import { setServerDisabled } from './disabled.js';
import type {
  McpServerConfig,
  McpServerEntry,
  McpServerStatus,
  McpTransport,
} from './types.js';

/** Anthropic / OpenAI-style tool name regex limit. */
const MAX_TOOL_NAME_LEN = 64;

interface ServerEntry {
  config: McpServerConfig;
  source?: string;
  status: McpServerStatus;
  client?: McpClient;
  tools: Tool[];
}

export interface McpManagerOptions {
  /** Hook for warnings (e.g. tool names that exceed length limit). Defaults to console.warn. */
  onWarn?: (msg: string) => void;
  /** Override connector (for tests). */
  connect?: (cfg: McpServerConfig) => Promise<McpClient>;
  /** Names of servers that should not connect — they appear in `status()` as
   * `{ state: 'disabled' }`. The set is loaded from `~/.lcode/mcp-disabled.json`
   * by the caller. */
  disabled?: Set<string>;
  /** Persistence sink for disable/enable. Defaults to writing
   * `~/.lcode/mcp-disabled.json`. Override for tests. */
  persistDisabled?: (name: string, disabled: boolean) => Promise<void>;
}

/** Accept either bare configs (legacy: tests, programmatic API) or entries
 * carrying a source path (current path: file-loader output). */
type InputServer = McpServerConfig | McpServerEntry;

function toEntry(item: InputServer): McpServerEntry {
  return 'config' in item ? item : { config: item };
}

/**
 * Owns the lifecycle of all configured MCP servers for a session: connects
 * in parallel, lists their tools, exposes adapter `Tool` objects to the
 * agent loop, and tracks per-server status for the `/mcp` slash command.
 *
 * One manager per chat session. `start()` is called once at session begin,
 * `close()` once at end. `reload()` reconnects everything (used by `/mcp reload`).
 */
export class McpManager {
  private entries = new Map<string, ServerEntry>();
  private warn: (msg: string) => void;
  private connect: (cfg: McpServerConfig) => Promise<McpClient>;
  private persist: (name: string, disabled: boolean) => Promise<void>;

  constructor(servers: InputServer[], opts: McpManagerOptions = {}) {
    this.warn = opts.onWarn ?? ((m) => console.warn(`[mcp] ${m}`));
    this.connect = opts.connect ?? connectMcpServer;
    this.persist = opts.persistDisabled ?? ((n, d) => setServerDisabled(n, d));
    const disabled = opts.disabled ?? new Set<string>();
    for (const item of servers) {
      const e = toEntry(item);
      const isDisabled = disabled.has(e.config.name);
      this.entries.set(e.config.name, {
        config: e.config,
        source: e.source,
        status: isDisabled ? { state: 'disabled' } : { state: 'connecting' },
        tools: [],
      });
    }
  }

  /**
   * Connect to every enabled server in parallel. Never throws — per-server
   * failures land in `status()` so the rest of the session can proceed.
   * Disabled servers are skipped.
   */
  async start(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()]
        .filter((e) => e.status.state !== 'disabled')
        .map((e) => this.connectOne(e)),
    );
  }

  /** Adapter tools from all currently-ready servers. */
  tools(): Tool[] {
    return [...this.entries.values()].flatMap((e) => e.tools);
  }

  /** Tools exposed by a single server (used by the picker's tool list). */
  toolsFor(name: string): Tool[] {
    return this.entries.get(name)?.tools ?? [];
  }

  /** Status snapshot keyed by server name. */
  status(): Map<string, McpServerStatus> {
    const out = new Map<string, McpServerStatus>();
    for (const [name, e] of this.entries) out.set(name, e.status);
    return out;
  }

  /** Server transport name (for `/mcp` rendering). */
  transportOf(name: string): McpTransport | null {
    return this.entries.get(name)?.config.type ?? null;
  }

  /** Path of the file the server was declared in, when known. */
  sourceOf(name: string): string | null {
    return this.entries.get(name)?.source ?? null;
  }

  /** Resolved config (used for showing URL/command in the detail view). */
  configOf(name: string): McpServerConfig | null {
    return this.entries.get(name)?.config ?? null;
  }

  isDisabled(name: string): boolean {
    return this.entries.get(name)?.status.state === 'disabled';
  }

  /** Close all clients and reconnect every enabled server using the same
   * configs. Disabled servers stay disabled. */
  async reload(): Promise<void> {
    await this.close();
    for (const e of this.entries.values()) {
      if (e.status.state === 'disabled') continue;
      e.status = { state: 'connecting' };
      e.tools = [];
      e.client = undefined;
    }
    await this.start();
  }

  /** Close + reconnect a single server. No-op if the server is disabled or
   * not configured. */
  async reconnect(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry || entry.status.state === 'disabled') return;
    const c = entry.client;
    entry.client = undefined;
    if (c) {
      try {
        await c.close();
      } catch {
        /* swallow */
      }
    }
    entry.status = { state: 'connecting' };
    entry.tools = [];
    await this.connectOne(entry);
  }

  /** Mark the server as disabled, drop its client + tools, and persist. */
  async disable(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    if (entry.status.state !== 'disabled') {
      const c = entry.client;
      entry.client = undefined;
      entry.tools = [];
      entry.status = { state: 'disabled' };
      if (c) {
        try {
          await c.close();
        } catch {
          /* swallow */
        }
      }
    }
    await this.persist(name, true);
  }

  /** Re-enable a previously disabled server, persist, and reconnect. */
  async enable(name: string): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry) return;
    if (entry.status.state === 'disabled') {
      entry.status = { state: 'connecting' };
      entry.tools = [];
    }
    await this.persist(name, false);
    if (entry.status.state === 'connecting') {
      await this.connectOne(entry);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.values()].map(async (e) => {
        const c = e.client;
        e.client = undefined;
        if (c) await c.close();
      }),
    );
  }

  private async connectOne(entry: ServerEntry): Promise<void> {
    const startedAt = Date.now();
    try {
      const client = await this.connect(entry.config);
      const mcpTools = await client.listTools();
      const adapted: Tool[] = [];
      for (const def of mcpTools) {
        const tool = adapt(entry.config.name, def, client, this.warn);
        if (tool) adapted.push(tool);
      }
      entry.client = client;
      entry.tools = adapted;
      entry.status = {
        state: 'ready',
        toolCount: adapted.length,
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      entry.client = undefined;
      entry.tools = [];
      entry.status = {
        state: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * Build a lcode `Tool` from one MCP-server tool definition, using
 * `mcp__<server>__<tool>` naming so the LLM sees the same names Claude Code
 * exposes. Returns null if the resulting name exceeds the LLM tool-name limit.
 */
export function adapt(
  serverName: string,
  def: McpToolDef,
  client: McpClient,
  warn: (msg: string) => void,
): Tool | null {
  const safeServer = normalizeServerName(serverName);
  const fullName = `mcp__${safeServer}__${def.name}`;
  if (fullName.length > MAX_TOOL_NAME_LEN) {
    warn(`tool "${fullName}" exceeds ${MAX_TOOL_NAME_LEN} chars — dropped`);
    return null;
  }
  return {
    name: fullName,
    description: def.description ?? '',
    // Passthrough — the MCP server validates input. We don't reuse Zod here
    // because MCP schemas can use JSON-Schema features (oneOf, refs, etc.)
    // that don't round-trip through zod-to-json-schema cleanly.
    inputSchema: z.unknown(),
    inputJsonSchema: def.inputSchema,
    handler: async (input) => {
      const r = await client.callTool(def.name, input);
      return { content: r.content, isError: r.isError };
    },
  };
}

/** Lowercase, replace anything outside [a-z0-9_] with `_`. */
export function normalizeServerName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}
