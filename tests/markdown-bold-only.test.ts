import { describe, expect, it } from 'vitest';
import { parseInline, stripEmphasisMarkers } from '../src/tui/markdown.js';

/**
 * Regression: `**Key Objectives & Strategy**` was rendering with literal `**`
 * markers visible to the user. These tests verify both the inline parser and
 * the boldOnly block-level regex strip the asterisks cleanly.
 */
describe('bold-only header line (regression)', () => {
  // Exact string the user reported as broken in the screenshot:
  const PROBLEM_LINE = '**Key Objectives & Strategy**';

  it('boldOnly regex matches and captures inner text', () => {
    const re = /^\s*\*{2,}([^*\n]+?)\*{2,}\s*$/;
    const m = PROBLEM_LINE.match(re);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('Key Objectives & Strategy');
  });

  it('parseInline strips both ** runs cleanly', () => {
    const spans = parseInline(PROBLEM_LINE);
    expect(spans).toEqual([{ kind: 'bold', text: 'Key Objectives & Strategy' }]);
  });

  it('parseInline handles 3 leading + 2 trailing asterisks', () => {
    expect(parseInline('***Key Objectives & Strategy**')).toEqual([
      { kind: 'bold', text: 'Key Objectives & Strategy' },
    ]);
  });

  it('parseInline handles 2 leading + 3 trailing asterisks', () => {
    expect(parseInline('**Key Objectives & Strategy***')).toEqual([
      { kind: 'bold', text: 'Key Objectives & Strategy' },
    ]);
  });

  it('parseInline handles all-3 (***) on both sides', () => {
    expect(parseInline('***Key Objectives & Strategy***')).toEqual([
      { kind: 'bold', text: 'Key Objectives & Strategy' },
    ]);
  });

  it('parseInline handles inline emphasis preceded by a colon', () => {
    expect(parseInline('summary: **Key Objectives & Strategy**')).toEqual([
      { kind: 'text', text: 'summary: ' },
      { kind: 'bold', text: 'Key Objectives & Strategy' },
    ]);
  });

  it('parseInline handles bold followed by trailing punctuation', () => {
    expect(parseInline('**Key Objectives & Strategy**:')).toEqual([
      { kind: 'bold', text: 'Key Objectives & Strategy' },
      { kind: 'text', text: ':' },
    ]);
  });
});

describe('stripEmphasisMarkers (heading inner-text cleanup)', () => {
  it('strips ** wrapped around a heading-style title', () => {
    // Real example from a session transcript: `## **Core Innovation: Chili!ASP**`
    expect(stripEmphasisMarkers('**Core Innovation: Chili!ASP**')).toBe(
      'Core Innovation: Chili!ASP',
    );
  });

  it('strips arbitrary-length runs', () => {
    expect(stripEmphasisMarkers('***Heading***')).toBe('Heading');
    expect(stripEmphasisMarkers('****quad****')).toBe('quad');
  });

  it('leaves plain text untouched', () => {
    expect(stripEmphasisMarkers('Plain Heading')).toBe('Plain Heading');
  });

  it('strips internal asterisks too (lossy but acceptable for headings)', () => {
    expect(stripEmphasisMarkers('Heading *with* emphasis')).toBe(
      'Heading with emphasis',
    );
  });
});
