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
    // `<|channel>thought<channel|>` is a complete directive → stripped
    // including the channel name. Surrounding content survives.
    const out = feedAll(f, ['I think <|channel>tho', 'ught<channel|> end of stream message text']);
    expect(out).toContain('I think');
    expect(out).toContain('end of stream message text');
    expect(out).not.toMatch(/\bthought\b/);
    expect(out).not.toContain('<|channel');
    expect(out).not.toContain('<channel|>');
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

  it('strips a trailing partial-open marker fragment on flush', () => {
    // Models sometimes end a turn mid-marker (next turn begins with the rest).
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['some real content and then <|channe']);
    expect(out).toBe('some real content and then ');
  });

  it('strips a leading partial-close marker fragment at start of stream', () => {
    // Counterpart to the above: a fresh turn whose first text is the tail
    // of a marker the previous turn began.
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['l>thought<channel|> rest of message visible to user']);
    expect(out).toBe('thought rest of message visible to user');
  });

  it('does not strip leading "5 > 3" or other digit-led text', () => {
    const f = new HarmonyNoiseFilter();
    const out = feedAll(f, ['5 > 3 means five is greater than three']);
    expect(out).toBe('5 > 3 means five is greater than three');
  });

  it('only strips leading partial close before the first emit', () => {
    // After we've already emitted text, a `word>` mid-stream must NOT be
    // mistaken for a marker fragment.
    const f = new HarmonyNoiseFilter();
    let out = '';
    out += f.feed('first batch of content long enough to flush past holdback');
    out += f.feed(' more>content here');
    out += f.flush();
    expect(out).toContain(' more>content here');
  });

  it("strips gemma4's actual leak shape (full-buffer single feed)", () => {
    // Captured verbatim from a real gemma4 response.
    const f = new HarmonyNoiseFilter();
    const raw =
      "I'll check the configuration and core logic to see which LLM " +
      'providers are supported.\n\n<|channel>thought\n<channel|>';
    const out = f.feed(raw) + f.flush();
    expect(out).not.toContain('<|channel>');
    expect(out).not.toContain('<channel|>');
    expect(out).not.toContain('<|chan');
    // The channel name `thought` is part of the directive, not content.
    expect(out).not.toMatch(/\bthought\b/);
    expect(out).toContain("I'll check the configuration");
  });

  it("strips gemma4's leak when chunked at every position", () => {
    const raw =
      'before content here. <|channel>thought\n<channel|> after content';
    for (let split = 1; split < raw.length; split++) {
      const f = new HarmonyNoiseFilter();
      const out =
        f.feed(raw.slice(0, split)) + f.feed(raw.slice(split)) + f.flush();
      expect(out, `split=${split}`).not.toContain('<|channel>');
      expect(out, `split=${split}`).not.toContain('<channel|>');
      expect(out, `split=${split}`).not.toContain('<|chan');
      expect(out, `split=${split}`).not.toMatch(/\bthought\b/);
      expect(out, `split=${split}`).toContain('before content here.');
      expect(out, `split=${split}`).toContain('after content');
    }
  });

  it('keeps "thought" as a normal word when not adjacent to a channel marker', () => {
    const f = new HarmonyNoiseFilter();
    const out =
      f.feed('I had a thought about this. ') +
      f.feed('It was a deep thought.') +
      f.flush();
    expect(out).toContain('I had a thought about this.');
    expect(out).toContain('It was a deep thought.');
  });

  it('strips proper Harmony channel directives (final, analysis)', () => {
    const f = new HarmonyNoiseFilter();
    const out =
      f.feed('<|channel|>analysis<|message|>secret reasoning<|end|>') +
      f.feed('<|channel|>final<|message|>visible answer<|end|>') +
      f.flush();
    expect(out).not.toContain('analysis');
    expect(out).not.toContain('final');
    expect(out).toContain('secret reasoning');
    expect(out).toContain('visible answer');
  });
});
