/**
 * Anthropic-shaped content blocks and SDK message types.
 *
 * These mirror the public shapes consumed by xerro-service so that
 * lcode's `query()` output can later substitute for Claude Agent SDK.
 */

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlockContent {
  type: 'text';
  text: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ToolResultBlockContent[];
  is_error?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type ImageMediaType = 'image/png' | 'image/jpeg';

/**
 * User-supplied images. Persisted to JSONL with `source.type === 'file_path'`
 * so the session log stays small (a few hundred bytes vs. multi-MB base64);
 * resolved to `source.type === 'base64'` at LLM send time.
 */
export interface ImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: ImageMediaType; data: string }
    | { type: 'file_path'; media_type: ImageMediaType; path: string };
}

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | ImageBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
}

export interface SDKSystemInitMessage {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd: string;
  model: string;
  tools: string[];
  permissionMode?: string;
}

export interface SDKAssistantMessage {
  type: 'assistant';
  session_id: string;
  message: {
    role: 'assistant';
    content: ContentBlock[];
    model: string;
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
    usage?: Usage;
  };
}

export interface SDKUserMessage {
  type: 'user';
  session_id: string;
  message: {
    role: 'user';
    content: ContentBlock[];
  };
}

export type PartialAssistantEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_start' }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'thinking_stop' }
  | { kind: 'tool_use_start'; id: string; name: string }
  | { kind: 'tool_use_input_delta'; id: string; partialJson: string }
  | { kind: 'tool_use_stop'; id: string };

export interface SDKPartialAssistantMessage {
  type: 'partial_assistant';
  session_id: string;
  event: PartialAssistantEvent;
}

export type ResultSubtype =
  | 'success'
  | 'error_max_turns'
  | 'error_aborted'
  | 'error_tool_failure'
  | 'error_repetition'
  | 'error_llm';

export interface SDKResultMessage {
  type: 'result';
  session_id: string;
  subtype: ResultSubtype;
  result?: string;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  usage?: Usage;
  error?: string;
}

/**
 * Records a compaction event in the session JSONL so that --resume
 * reconstructs the post-compaction history. Tier 1 truncates listed
 * tool_results to stubs; Tier 2 replaces all prior assistant/user
 * messages (above the preserved tail) with the synthesized summary.
 */
export interface SDKCompactionMessage {
  type: 'compaction';
  session_id: string;
  subtype: 'tier1' | 'tier2';
  /** Local BPE estimate of tokens reclaimed. Informational only. */
  saved_tokens: number;
  /** Tier 2: synthesized summary replacing the pre-tail conversation. */
  summary?: string;
  /** Tool_use ids whose results were truncated (Tier 1 + Tier 2). */
  truncated_tool_use_ids: string[];
}

/**
 * Live progress event from a sub-agent, surfaced to the parent loop's
 * yield stream so the TUI can render the sub-agent's tool calls in
 * real time under the parent's `Task` tool_call block.
 */
export type SubagentProgressEvent =
  | { kind: 'init' }
  | { kind: 'text_delta'; text: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { kind: 'tool_result'; tool_use_id: string; isError: boolean }
  | { kind: 'turn_end' };

export interface SDKSubagentProgressMessage {
  type: 'subagent_progress';
  session_id: string;
  /** ID of the parent's `Task` tool_use this event is reporting on. */
  parent_tool_use_id: string;
  event: SubagentProgressEvent;
}

export type SDKMessage =
  | SDKSystemInitMessage
  | SDKAssistantMessage
  | SDKUserMessage
  | SDKPartialAssistantMessage
  | SDKResultMessage
  | SDKCompactionMessage
  | SDKSubagentProgressMessage;

export function textBlock(text: string): TextBlock {
  return { type: 'text', text };
}

export function imageBlockFromPath(
  path: string,
  mediaType: ImageMediaType,
): ImageBlock {
  return { type: 'image', source: { type: 'file_path', media_type: mediaType, path } };
}

export function toolResultBlock(
  toolUseId: string,
  content: string,
  isError = false,
): ToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content,
    is_error: isError,
  };
}
