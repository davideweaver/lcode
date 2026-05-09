import type { z } from 'zod';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  sessionState: SessionState;
  /**
   * Run a one-shot non-streaming LLM completion using lcode's configured
   * model. Used by tools (e.g. WebFetch) that need a side-channel call
   * without re-entering the agent loop. Undefined when caller doesn't
   * wire it (e.g. some tests or out-of-loop tool dispatch).
   */
  runCompletion?: (req: {
    systemPrompt?: string;
    userPrompt: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  /** SearXNG base URL for WebSearch. Empty/undefined disables the tool. */
  searxngUrl?: string;
}

/**
 * Per-session mutable state shared between tool calls.
 * Used e.g. by Edit to enforce "Read first" semantics.
 */
export interface SessionState {
  readFiles: Set<string>;
}

export function newSessionState(): SessionState {
  return { readFiles: new Set() };
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export type ErasedToolHandler = (
  input: unknown,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult;

export interface Tool {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /**
   * Optional pre-built JSON Schema sent to the LLM in place of converting
   * `inputSchema` via zod-to-json-schema. MCP-adapter tools set this from the
   * server-provided schema (which doesn't round-trip cleanly through Zod).
   */
  inputJsonSchema?: object;
  handler: ErasedToolHandler;
  /** Read-only tools can run under permissionMode: 'plan' (Phase 2). */
  readOnly?: boolean;
}

export interface SdkMcpServerConfig {
  type: 'sdk';
  name: string;
  tools: Tool[];
}
