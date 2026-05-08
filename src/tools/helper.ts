import type { z } from 'zod';
import type { ErasedToolHandler, SdkMcpServerConfig, Tool, ToolContext, ToolResult } from './types.js';

export interface ToolOptions {
  readOnly?: boolean;
}

export type TypedToolHandler<TSchema extends z.ZodTypeAny> = (
  input: z.infer<TSchema>,
  ctx: ToolContext,
) => Promise<ToolResult> | ToolResult;

/**
 * Define a tool with a Zod input schema and async handler.
 * Mirrors the shape of @anthropic-ai/claude-agent-sdk's `tool()`.
 *
 * The schema generic is preserved on the handler parameter only — the
 * returned Tool stores an erased handler so tools with different schemas
 * can coexist in the same registry/array.
 */
export function tool<TSchema extends z.ZodTypeAny>(
  name: string,
  description: string,
  inputSchema: TSchema,
  handler: TypedToolHandler<TSchema>,
  options: ToolOptions = {},
): Tool {
  return {
    name,
    description,
    inputSchema,
    handler: handler as ErasedToolHandler,
    readOnly: options.readOnly,
  };
}

/**
 * Group tools into a logical "MCP server" for `query({mcpServers})`.
 * Phase 1: stub — accepts the shape so callers compile, but we wire
 * dispatch via the same tool registry as built-ins. Phase 2 makes
 * MCP-shaped registration first-class.
 */
export function createSdkMcpServer(name: string, tools: Tool[]): SdkMcpServerConfig {
  return { type: 'sdk', name, tools };
}
