import { describe, expect, it } from 'vitest';
import { isHorizontalRule, parseTable } from '../src/tui/markdown.js';

describe('isHorizontalRule', () => {
  it('detects --- as HR', () => {
    expect(isHorizontalRule('---')).toBe(true);
    expect(isHorizontalRule('-----')).toBe(true);
    expect(isHorizontalRule('  ---  ')).toBe(true);
  });

  it('detects *** and ___ as HR', () => {
    expect(isHorizontalRule('***')).toBe(true);
    expect(isHorizontalRule('___')).toBe(true);
  });

  it('detects spaced HR', () => {
    expect(isHorizontalRule('- - -')).toBe(true);
    expect(isHorizontalRule('* * *')).toBe(true);
  });

  it('rejects short or mixed runs', () => {
    expect(isHorizontalRule('--')).toBe(false);
    expect(isHorizontalRule('-*-')).toBe(false);
    expect(isHorizontalRule('---x')).toBe(false);
    expect(isHorizontalRule('')).toBe(false);
  });

  it('rejects ordinary text', () => {
    expect(isHorizontalRule('hello')).toBe(false);
    expect(isHorizontalRule('- item')).toBe(false);
  });
});

describe('parseTable', () => {
  it('parses a basic 3-column table', () => {
    const lines = [
      '| Feature | A | B |',
      '| :--- | :--- | :--- |',
      '| Cost | 15% | 5% |',
      '| Time | High | Low |',
    ];
    const t = parseTable(lines, 0);
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(['Feature', 'A', 'B']);
    expect(t!.rows).toEqual([
      ['Cost', '15%', '5%'],
      ['Time', 'High', 'Low'],
    ]);
    expect(t!.aligns).toEqual(['left', 'left', 'left']);
    expect(t!.end).toBe(4);
  });

  it('detects alignment from separator', () => {
    const lines = [
      '| L | C | R |',
      '|:---|:---:|---:|',
      '| a | b | c |',
    ];
    const t = parseTable(lines, 0);
    expect(t!.aligns).toEqual(['left', 'center', 'right']);
  });

  it('handles tables without leading/trailing pipes', () => {
    const lines = [
      'A | B',
      '---|---',
      'x | y',
    ];
    const t = parseTable(lines, 0);
    expect(t).not.toBeNull();
    expect(t!.header).toEqual(['A', 'B']);
    expect(t!.rows).toEqual([['x', 'y']]);
  });

  it('stops at the first non-table line', () => {
    const lines = [
      '| A | B |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      'paragraph after',
    ];
    const t = parseTable(lines, 0);
    expect(t!.end).toBe(3);
    expect(t!.rows).toEqual([['1', '2']]);
  });

  it('returns null when separator row is missing', () => {
    const lines = ['| A | B |', '| 1 | 2 |'];
    expect(parseTable(lines, 0)).toBeNull();
  });

  it('returns null for a non-table line', () => {
    expect(parseTable(['just text'], 0)).toBeNull();
  });
});
