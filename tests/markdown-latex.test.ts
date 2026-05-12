import { describe, expect, it } from 'vitest';
import { replaceLatexMath } from '../src/tui/markdown.js';

describe('replaceLatexMath', () => {
  it('replaces $\\rightarrow$ with arrow glyph and strips delimiters', () => {
    expect(replaceLatexMath('RTC $\\rightarrow$ Tabulator')).toBe(
      'RTC → Tabulator',
    );
  });

  it('handles \\(...\\) delimiters', () => {
    expect(replaceLatexMath('flow: \\(\\rightarrow\\) here')).toBe(
      'flow: → here',
    );
  });

  it('handles \\[...\\] display delimiters', () => {
    expect(replaceLatexMath('block: \\[\\Rightarrow\\]')).toBe('block: ⇒');
  });

  it('replaces multiple symbols inside one delimiter pair', () => {
    expect(replaceLatexMath('$x \\to y \\to z$')).toBe('x → y → z');
  });

  it('replaces a bare \\rightarrow without delimiters', () => {
    expect(replaceLatexMath('Use \\rightarrow to indicate flow')).toBe(
      'Use → to indicate flow',
    );
  });

  it('leaves dollar amounts alone', () => {
    expect(replaceLatexMath('costs $5 and $10 total')).toBe(
      'costs $5 and $10 total',
    );
  });

  it('leaves unknown backslash commands alone', () => {
    expect(replaceLatexMath('path C:\\Users\\dave and \\unknowncmd')).toBe(
      'path C:\\Users\\dave and \\unknowncmd',
    );
  });

  it('does not collapse $...$ containing unrecognized commands', () => {
    expect(replaceLatexMath('$\\frac{1}{2}$')).toBe('$\\frac{1}{2}$');
  });

  it('handles greek letters', () => {
    expect(replaceLatexMath('let $\\alpha$ and $\\beta$ be angles')).toBe(
      'let α and β be angles',
    );
  });

  it('handles comparison operators', () => {
    expect(replaceLatexMath('require $\\leq$ 5, $\\neq$ 0')).toBe(
      'require ≤ 5, ≠ 0',
    );
  });

  it('preserves \\n style escapes that look like commands but are not', () => {
    // \n is not in the lookup, so it's untouched.
    expect(replaceLatexMath('line\\nbreak')).toBe('line\\nbreak');
  });

  it('handles the original reported case', () => {
    const input = 'Old Way: RTC $\\rightarrow$ (Direct Queries) $\\rightarrow$ Kazoo.';
    expect(replaceLatexMath(input)).toBe(
      'Old Way: RTC → (Direct Queries) → Kazoo.',
    );
  });
});
