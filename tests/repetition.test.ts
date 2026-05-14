import { describe, expect, it } from 'vitest';
import { detectRepetition, RepetitionMonitor } from '../src/core/repetition.js';

/**
 * Random-looking string of length N with no internal period >=2 in any
 * 40+ char window. Used to construct unambiguous test inputs where the
 * smallest valid repetition period is exactly the block length.
 */
function noisy(n: number, seed = 1): string {
  const alpha = 'abcdefghijklmnopqrstuvwxyz';
  let s = '';
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += alpha[x % 26];
  }
  return s;
}

describe('detectRepetition', () => {
  it('returns null on prose with no long repetition', () => {
    const text =
      'The user is pointing out a centering issue. Looking at the screenshot ' +
      'provided, the title and subtitle are centered, but the cards are not. ' +
      'I should inspect ComparisonSection.astro to understand the grid layout.';
    expect(detectRepetition(text)).toBeNull();
  });

  it('returns null when fewer than `cycles` blocks have accumulated', () => {
    const block = noisy(100);
    expect(detectRepetition(block + block)).toBeNull();
  });

  it('detects three back-to-back identical blocks', () => {
    const block = noisy(100);
    const result = detectRepetition(block + block + block);
    expect(result).not.toBeNull();
    expect(result!.period).toBe(100);
  });

  it('detects the real-world Wait/Actually oscillation', () => {
    const cycle =
      "Actually, I'll just update `index.astro` to remove the wrapper. That's the immediate fix.\n" +
      "Wait, I'll also update `ComparisonSection.astro` to use `max-w-4xl` for the grid to keep it tight.\n";
    const leadIn = 'Some non-repeating analysis text here, then a transition.\n';
    expect(detectRepetition(leadIn + cycle + cycle + cycle)).not.toBeNull();
  });

  it('flags single-char runaway (model stuck emitting one character)', () => {
    // A model outputting 'a' for 2000 chars is just as degenerate as one
    // looping two sentences; minPeriod just delays detection until enough
    // chars accumulate that the period also satisfies the minimum.
    expect(detectRepetition('a'.repeat(2000))).not.toBeNull();
  });

  it('respects the maxPeriod cap when the true period is unique and large', () => {
    const block = noisy(700);
    const text = block + block + block;
    expect(detectRepetition(text, { maxPeriod: 600 })).toBeNull();
    expect(detectRepetition(text, { maxPeriod: 800 })).not.toBeNull();
  });

  it('finds the smallest valid period when several would match', () => {
    // 50-char unique block — smallest non-trivial repetition is exactly 50.
    const block50 = noisy(50);
    const text = block50.repeat(6);
    const result = detectRepetition(text);
    expect(result!.period).toBe(50);
  });
});

describe('RepetitionMonitor', () => {
  it('rate-limits scans until CHECK_INTERVAL chars accumulate', () => {
    const mon = new RepetitionMonitor();
    mon.feed('x'.repeat(50));
    expect(mon.check()).toBeNull();
  });

  it('fires once enough deltas have accumulated', () => {
    const mon = new RepetitionMonitor();
    const block = noisy(80);
    // 240 chars of repetition — past CHECK_INTERVAL and tail is fully periodic.
    mon.feed(block.repeat(3));
    expect(mon.check()).not.toBeNull();
  });

  it('does not fire on a long stream of varied content', () => {
    const mon = new RepetitionMonitor({ maxPeriod: 100, cycles: 3 });
    for (let i = 0; i < 100; i++) {
      mon.feed(noisy(1024, i + 1));
    }
    expect(mon.check()).toBeNull();
  });
});
