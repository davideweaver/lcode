export interface StdioMcpServerConfig {
  type: 'stdio';
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpMcpServerConfig {
  type: 'http';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface SseMcpServerConfig {
  type: 'sse';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig =
  | StdioMcpServerConfig
  | HttpMcpServerConfig
  | SseMcpServerConfig;

export type McpTransport = McpServerConfig['type'];

export type McpServerStatus =
  | { state: 'connecting' }
  | { state: 'ready'; toolCount: number; latencyMs: number }
  | { state: 'failed'; error: string }
  | { state: 'disabled' };

/** Config + the file path it was loaded from. Used by the manager so the
 * `/mcp` picker can show the user where each server is declared. */
export interface McpServerEntry {
  config: McpServerConfig;
  source?: string;
}
