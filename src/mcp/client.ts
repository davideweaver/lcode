import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: object;
}

export interface McpCallResult {
  content: string;
  isError: boolean;
}

export interface McpClient {
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: unknown): Promise<McpCallResult>;
  close(): Promise<void>;
}

const CLIENT_INFO = { name: 'lcode', version: '0.0.1' };

/**
 * Connect to an MCP server using the transport described in `cfg`. The
 * returned `McpClient` is a thin facade over `@modelcontextprotocol/sdk`'s
 * `Client` so the rest of lcode doesn't import from the SDK directly.
 */
export async function connectMcpServer(cfg: McpServerConfig): Promise<McpClient> {
  const client = new Client(CLIENT_INFO);
  if (cfg.type === 'stdio') {
    // Stdio servers (especially mcp-remote proxies) write proxy logs to
    // stderr. The SDK's default is "inherit", which corrupts Ink's TUI
    // output. Pipe stderr instead and drain it to a per-server log file.
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args ?? [],
      env: cfg.env ? { ...inheritedEnv(), ...cfg.env } : undefined,
      stderr: 'pipe',
    });
    await client.connect(transport);
    pipeStderrToLog(transport, cfg.name);
    return wrap(client);
  }
  const transport =
    cfg.type === 'http'
      ? new StreamableHTTPClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        })
      : new SSEClientTransport(new URL(cfg.url), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
  await client.connect(transport);
  return wrap(client);
}

/** Drain stdio MCP server stderr into ~/.lcode/logs/mcp/<server>.log so it
 * doesn't pollute the TUI but stays available for debugging. */
function pipeStderrToLog(transport: StdioClientTransport, serverName: string) {
  const stream = transport.stderr;
  if (!stream) return;
  let logStream: WriteStream | null = null;
  try {
    const dir = join(homedir(), '.lcode', 'logs', 'mcp');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    logStream = createWriteStream(join(dir, `${safeFilename(serverName)}.log`), {
      flags: 'a',
    });
  } catch {
    /* if we can't open the log, swallow stderr silently — better than crashing */
  }
  if (logStream) {
    stream.pipe(logStream);
  } else {
    // No log destination — at least don't write to our own stderr. Drain
    // the stream so the child process doesn't block on a full pipe buffer.
    stream.on('data', () => {});
  }
}

function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * MCP's StdioClientTransport defaults to a sanitized env subset when `env`
 * is omitted, but will *replace* it entirely when we pass our own dict. We
 * want children to inherit lcode's PATH etc. while still applying caller
 * overrides, so we manually merge.
 */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function wrap(client: Client): McpClient {
  return {
    async listTools() {
      const r = await client.listTools();
      return r.tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
    },
    async callTool(name, args) {
      const r = (await client.callTool({
        name,
        arguments: (args ?? {}) as Record<string, unknown>,
      })) as unknown;
      return flattenResult(r);
    },
    async close() {
      try {
        await client.close();
      } catch {
        /* swallow — close is best-effort */
      }
    },
  };
}

/**
 * Collapse MCP's heterogeneous result into a single string. The SDK's
 * callTool result is a union — most servers return `{ content: [...] }`,
 * but the spec also allows a `{ toolResult: ... }` legacy shape. We accept
 * either and stringify whatever's there. Non-text content blocks are
 * summarized so the model sees something rather than a silent drop.
 */
function flattenResult(r: unknown): McpCallResult {
  if (!r || typeof r !== 'object') {
    return { content: '', isError: false };
  }
  const obj = r as { content?: unknown; toolResult?: unknown; isError?: unknown };
  const isError = obj.isError === true;
  if (Array.isArray(obj.content)) {
    const parts: string[] = [];
    for (const b of obj.content) {
      if (!b || typeof b !== 'object') continue;
      const block = b as { type?: unknown; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (typeof block.type === 'string') {
        parts.push(`[${block.type} content omitted]`);
      }
    }
    return { content: parts.join('\n'), isError };
  }
  if (obj.toolResult !== undefined) {
    const t = obj.toolResult;
    return {
      content: typeof t === 'string' ? t : JSON.stringify(t),
      isError,
    };
  }
  return { content: '', isError };
}
