import type { SDKMessage } from '../core/messages.js';
import type { UiBlock } from './types.js';

/**
 * Convert a session's JSONL message stream into UI blocks for display.
 * Used by /resume so the user sees the past conversation when reopening
 * a session.
 */
export function messagesToBlocks(messages: SDKMessage[]): UiBlock[] {
  const blocks: UiBlock[] = [];
  // Map tool_use_id → index of the matching tool_call block, so a later
  // user/tool_result message can find and update it.
  const toolCallIdx = new Map<string, number>();

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          blocks.push({ kind: 'assistant_text', text: block.text, streaming: false });
        } else if (block.type === 'thinking') {
          blocks.push({
            kind: 'thinking',
            text: block.thinking,
            streaming: false,
            startedAt: 0, // not tracked across sessions
            durationMs: 0,
          });
        } else if (block.type === 'tool_use') {
          blocks.push({
            kind: 'tool_call',
            id: block.id,
            name: block.name,
            input: block.input,
            status: 'pending',
          });
          toolCallIdx.set(block.id, blocks.length - 1);
        }
      }
      continue;
    }
    if (msg.type === 'user') {
      for (const block of msg.message.content) {
        if (block.type === 'text') {
          blocks.push({ kind: 'user_prompt', text: block.text });
        } else if (block.type === 'tool_result') {
          const idx = toolCallIdx.get(block.tool_use_id);
          if (idx === undefined) continue;
          const target = blocks[idx];
          if (!target || target.kind !== 'tool_call') continue;
          const text =
            typeof block.content === 'string'
              ? block.content
              : block.content.map((c) => c.text).join('');
          blocks[idx] = {
            ...target,
            status: block.is_error ? 'error' : 'done',
            result: text,
          };
        }
      }
      continue;
    }
    if (msg.type === 'result' && msg.subtype !== 'success') {
      blocks.push({
        kind: 'result',
        subtype: msg.subtype,
        text: msg.error ?? msg.result,
      });
    }
  }
  return blocks;
}
