import type { z } from 'zod';

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  sessionState: SessionState;
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
  handler: ErasedToolHandler;
  /** Read-only tools can run under permissionMode: 'plan' (Phase 2). */
  readOnly?: boolean;
}

export interface SdkMcpServerConfig {
  type: 'sdk';
  name: string;
  tools: Tool[];
}
