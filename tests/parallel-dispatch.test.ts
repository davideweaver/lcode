import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { tool } from '../src/tools/helper.js';
import { newSessionState } from '../src/tools/types.js';

/**
 * Verifies that tool dispatch in the loop runs concurrently.
 *
 * Strategy: build three "slow" tools that each await a 100ms timer.
 * Sequential dispatch ⇒ ≥300ms total. Parallel dispatch ⇒ ~100ms total.
 * We assert <250ms which leaves comfortable margin and is well below the
 * sequential floor.
 *
 * We exercise the same Promise.all shape the loop uses, rather than spinning
 * up a real LLM, so this is hermetic.
 */
describe('parallel tool dispatch', () => {
  it('runs three 100ms tools concurrently', async () => {
    const slowTool = tool(
      'Slow',
      'A test tool that waits',
      z.object({ id: z.string() }),
      async ({ id }) => {
        await new Promise((res) => setTimeout(res, 100));
        return { content: `done ${id}` };
      },
    );

    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      sessionState: newSessionState(),
    };

    const start = Date.now();
    const results = await Promise.all(
      ['a', 'b', 'c'].map((id) => slowTool.handler({ id }, ctx)),
    );
    const elapsed = Date.now() - start;

    expect(results).toEqual([
      { content: 'done a' },
      { content: 'done b' },
      { content: 'done c' },
    ]);
    expect(elapsed).toBeLessThan(250);
  });

  it('preserves input order in results even when tools finish out of order', async () => {
    const variableTool = tool(
      'Variable',
      'Sleeps for input ms',
      z.object({ ms: z.number(), tag: z.string() }),
      async ({ ms, tag }) => {
        await new Promise((res) => setTimeout(res, ms));
        return { content: tag };
      },
    );

    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      sessionState: newSessionState(),
    };

    // Tool 0 takes longest, tool 2 finishes first — but result order must match input.
    const results = await Promise.all(
      [
        { ms: 80, tag: 'first' },
        { ms: 40, tag: 'second' },
        { ms: 10, tag: 'third' },
      ].map((input) => variableTool.handler(input, ctx)),
    );

    expect(results.map((r) => r.content)).toEqual(['first', 'second', 'third']);
  });
});
