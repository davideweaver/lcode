import type { ContentBlock, SDKMessage } from '../core/messages.js';

/**
 * Crude character-based token estimate. ~4 chars per token is a common
 * heuristic for English / code on BPE-style tokenizers (gemma, qwen, llama).
 *
 * It's not exact, but it's good enough to spot when context is filling up,
 * and it doesn't require shipping a tokenizer with the TUI.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function contentBlockTokens(block: ContentBlock): number {
  switch (block.type) {
    case 'text':
      return estimateTokens(block.text);
    case 'tool_use':
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input));
    case 'tool_result': {
      const text = typeof block.content === 'string'
        ? block.content
        : block.content.map((c) => c.text).join('');
      return estimateTokens(text);
    }
    case 'thinking':
      return estimateTokens(block.thinking);
  }
}

/**
 * Sum tokens contributed by an SDK message that travels in the LLM prompt.
 * system/init, partial_assistant, and result messages don't count toward
 * the next turn's prompt — they're transcript-only.
 */
export function sdkMessageTokens(msg: SDKMessage): number {
  if (msg.type === 'assistant') {
    return msg.message.content.reduce((sum, b) => sum + contentBlockTokens(b), 0);
  }
  if (msg.type === 'user') {
    return msg.message.content.reduce((sum, b) => sum + contentBlockTokens(b), 0);
  }
  return 0;
}

export interface TokenStats {
  used: number;
  limit: number;
  percent: number;
}

export function tokenStats(used: number, limit: number): TokenStats {
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return { used, limit, percent };
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.floor(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
