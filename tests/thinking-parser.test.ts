import { describe, expect, it } from 'vitest';
import { ThinkingStreamParser, type ParseEvent } from '../src/core/thinking-parser.js';

function feedAll(parser: ThinkingStreamParser, chunks: string[]): ParseEvent[] {
  const events: ParseEvent[] = [];
  for (const c of chunks) {
    for (const ev of parser.feed(c)) events.push(ev);
  }
  for (const ev of parser.flush()) events.push(ev);
  return events;
}

function joinText(events: ParseEvent[]): string {
  return events
    .filter((e) => e.kind === 'text_delta')
    .map((e) => (e as { text: string }).text)
    .join('');
}

function joinThinking(events: ParseEvent[]): string {
  return events
    .filter((e) => e.kind === 'thinking_delta')
    .map((e) => (e as { text: string }).text)
    .join('');
}

describe('ThinkingStreamParser', () => {
  it('emits plain text with no tags', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['hello world']);
    expect(events).toEqual([{ kind: 'text_delta', text: 'hello world' }]);
  });

  it('splits a complete <think>…</think> in one chunk', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, [
      'before<think>I should plan</think>after',
    ]);
    expect(joinText(events)).toBe('beforeafter');
    expect(joinThinking(events)).toBe('I should plan');
    expect(events.map((e) => e.kind)).toEqual([
      'text_delta',
      'thinking_start',
      'thinking_delta',
      'thinking_stop',
      'text_delta',
    ]);
  });

  it('handles open tag split across chunks', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['abc<thi', 'nk>plan</think>more']);
    expect(joinText(events)).toBe('abcmore');
    expect(joinThinking(events)).toBe('plan');
  });

  it('handles close tag split across chunks', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['<think>thinking</thi', 'nk>after']);
    expect(joinText(events)).toBe('after');
    expect(joinThinking(events)).toBe('thinking');
  });

  it('handles a long stream of single-char chunks (token-by-token)', () => {
    const p = new ThinkingStreamParser();
    const input = 'abc<think>plan and then act</think>final';
    const events = feedAll(p, input.split(''));
    expect(joinText(events)).toBe('abcfinal');
    expect(joinThinking(events)).toBe('plan and then act');
  });

  it('emits thinking_start exactly once per opening tag', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['<think>x</think>y<think>z</think>']);
    const starts = events.filter((e) => e.kind === 'thinking_start');
    const stops = events.filter((e) => e.kind === 'thinking_stop');
    expect(starts).toHaveLength(2);
    expect(stops).toHaveLength(2);
    expect(joinThinking(events)).toBe('xz');
    expect(joinText(events)).toBe('y');
  });

  it('does not false-match "<thinky>" or other non-matching prefixes', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['use <thinky> for ', 'parsing']);
    expect(joinText(events)).toBe('use <thinky> for parsing');
    expect(joinThinking(events)).toBe('');
  });

  it('flushes unclosed thinking on stream end', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['<think>incomplete']);
    expect(joinThinking(events)).toBe('incomplete');
    // Should still emit thinking_stop on flush so consumers can finalize.
    expect(events.map((e) => e.kind)).toContain('thinking_stop');
  });

  it('handles empty thinking block', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['a<think></think>b']);
    expect(joinText(events)).toBe('ab');
    expect(joinThinking(events)).toBe('');
    expect(events.map((e) => e.kind)).toEqual([
      'text_delta',
      'thinking_start',
      'thinking_stop',
      'text_delta',
    ]);
  });

  it('does not stall on lone "<" in text', () => {
    const p = new ThinkingStreamParser();
    const events = feedAll(p, ['use < to compare']);
    expect(joinText(events)).toBe('use < to compare');
  });
});
