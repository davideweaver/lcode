import { encode } from 'gpt-tokenizer/encoding/o200k_base';
import type { ContentBlock, SDKMessage } from '../core/messages.js';

// Real BPE token count via o200k_base — the modern 200k-vocab encoding.
// Local models use their own tokenizers (Llama-3 / Qwen / Gemma); this is a
// budget proxy, not a per-model exact match. Drift is bounded; compaction
// thresholds reserve enough headroom that the proxy is good enough to drive
// scheduling decisions.
export function estimateTokens(s: string): number {
  if (s.length === 0) return 0;
  return encode(s).length;
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
