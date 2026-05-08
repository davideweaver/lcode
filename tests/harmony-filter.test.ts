import { describe, expect, it } from 'vitest';
import {
  HarmonyNoiseFilter,
  stripHarmonyMarkers,
} from '../src/core/harmony-filter.js';

function feedAll(filter: HarmonyNoiseFilter, chunks: string[]): string {
  let out = '';
  for (const c of chunks) out += filter.feed(c);
  out += filter.flush();
  return out;
}

describe('stripHarmonyMarkers (one-shot)', () => {
  it('strips proper paired markers', () => {
    expect(stripHarmonyMarkers('text<|channel|>thought<|message|>more')).toBe(
      'textthoughtmore',
    );
  });

  it('strips malformed half-markers (missing leading or trailing |)', () => {
    expect(stripHarmonyMarkers('a<|channel>thought<channel|>b')).toBe('athoughtb');
  });

  it('leaves unrelated <foo> alone', () => {
    expect(stripHarmonyMarkers('use <span>html</span> tags')).toBe(
      'use <span>html</span> tags',
    );
  });

  it('strips im_start/im_end and end markers', () => {
    expect(
      stripHarmonyMarkers('<|im_start|>system\nrules<|im_end|>'),
    ).toBe('system\nrules');
    expect(stripHarmonyMarkers('reasoning<|end|>')).toBe('reasoning');
  });
});

describe('HarmonyNoiseFilter (streaming)', () => {
  it('strips a complete marker in one chunk after enough buffer', () => {
    const f = new HarmonyNoiseFilter();
    // The hold-back is 20 chars, so we need enough buffer to flush.
    const out = feedAll(f, ['hello world<|channel|>hi the rest of this string is long enough']);
    expect(out).toBe('hello worldhi the rest of this string is long enough');
  });

  it('strips a marker split across chunks', () => {
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['hello <|chan', 'nel|> world ', 'and more text past the holdback']);
    expect(out).toBe('hello  world and more text past the holdback');
  });

  it('strips malformed markers split across chunks', () => {
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['I think <|channel>tho', 'ught<channel|> end of stream message text']);
    expect(out).toBe('I think thought end of stream message text');
  });

  it('passes plain text through unchanged after flush', () => {
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['just a plain message with no markers at all here']);
    expect(out).toBe('just a plain message with no markers at all here');
  });

  it('handles markers right at end of stream via flush', () => {
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['final<|end|>']);
    expect(out).toBe('final');
  });

  it('does not stall on text containing < without |', () => {
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['if (x < 5) { return; }']);
    expect(out).toBe('if (x < 5) { return; }');
  });
});
