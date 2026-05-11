import { describe, expect, it } from 'vitest';
import { anthropicToOpenAI } from '../src/core/llm.js';
import type { AnthropicMessage } from '../src/core/messages.js';

describe('anthropicToOpenAI', () => {
  it('passes through string content for user/assistant', async () => {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const out = await anthropicToOpenAI('SYS', messages);
    expect(out).toEqual([
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('emits tool_calls for assistant tool_use blocks', async () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/a' } },
        ],
      },
    ];
    const out = await anthropicToOpenAI('', messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'reading',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'Read', arguments: JSON.stringify({ file_path: '/a' }) },
        },
      ],
    });
  });

  it('splits tool_result blocks into role:tool messages', async () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' },
          { type: 'text', text: 'now what?' },
        ],
      },
    ];
    const out = await anthropicToOpenAI('', messages);
    expect(out).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents' },
      { role: 'user', content: 'now what?' },
    ]);
  });

  it('omits empty content for assistant with only tool_use', async () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'ls' } }],
      },
    ];
    const out = await anthropicToOpenAI('', messages);
    expect(out[0]).toMatchObject({ role: 'assistant', content: null });
    expect(out[0]).toHaveProperty('tool_calls');
  });

  it('rewraps thinking blocks as <think>…</think> when sending back', async () => {
    const messages: AnthropicMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should call Read first' },
          { type: 'text', text: "Reading the file." },
          { type: 'tool_use', id: 'c1', name: 'Read', input: { file_path: '/x' } },
        ],
      },
    ];
    const out = await anthropicToOpenAI('', messages);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe(
      '<think>I should call Read first</think>Reading the file.',
    );
    expect(out[0]).toHaveProperty('tool_calls');
  });
});
