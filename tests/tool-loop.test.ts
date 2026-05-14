import { describe, expect, it } from 'vitest';
import { fingerprintToolCalls } from '../src/core/loop.js';
import type { ToolUseBlock } from '../src/core/messages.js';

function call(name: string, input: Record<string, unknown>, id = 'x'): ToolUseBlock {
  return { type: 'tool_use', id, name, input };
}

describe('fingerprintToolCalls', () => {
  it('produces the same fingerprint for identical calls in either order', () => {
    const a = [call('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }, 'id1')];
    const b = [call('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }, 'id2')];
    // Different ids — the fingerprint must ignore id and depend only on name+input.
    expect(fingerprintToolCalls(a)).toBe(fingerprintToolCalls(b));
  });

  it('is order-independent for parallel tool calls', () => {
    const a = [
      call('Read', { file_path: '/a' }),
      call('Bash', { command: 'ls' }),
    ];
    const b = [
      call('Bash', { command: 'ls' }),
      call('Read', { file_path: '/a' }),
    ];
    expect(fingerprintToolCalls(a)).toBe(fingerprintToolCalls(b));
  });

  it('distinguishes different arguments', () => {
    const a = [call('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' })];
    const b = [call('Edit', { file_path: '/a', old_string: 'X', new_string: 'y' })];
    expect(fingerprintToolCalls(a)).not.toBe(fingerprintToolCalls(b));
  });

  it('distinguishes different tools', () => {
    const a = [call('Read', { file_path: '/a' })];
    const b = [call('Write', { file_path: '/a' })];
    expect(fingerprintToolCalls(a)).not.toBe(fingerprintToolCalls(b));
  });
});
