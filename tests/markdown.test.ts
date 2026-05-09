import { describe, expect, it } from 'vitest';
import { parseInline } from '../src/tui/markdown.js';

describe('parseInline', () => {
  it('parses plain text', () => {
    expect(parseInline('hello world')).toEqual([
      { kind: 'text', text: 'hello world' },
    ]);
  });

  it('parses bold', () => {
    expect(parseInline('this is **bold** text')).toEqual([
      { kind: 'text', text: 'this is ' },
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' text' },
    ]);
  });

  it('parses inline code', () => {
    expect(parseInline('use `npm install` here')).toEqual([
      { kind: 'text', text: 'use ' },
      { kind: 'code', text: 'npm install' },
      { kind: 'text', text: ' here' },
    ]);
  });

  it('parses italic', () => {
    expect(parseInline('a *single* word')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'italic', text: 'single' },
      { kind: 'text', text: ' word' },
    ]);
  });

  it('handles bullet list line with bold', () => {
    expect(parseInline('- **Purpose**: A local CLI tool.')).toEqual([
      { kind: 'text', text: '- ' },
      { kind: 'bold', text: 'Purpose' },
      { kind: 'text', text: ': A local CLI tool.' },
    ]);
  });

  it('handles mixed bold and code', () => {
    expect(parseInline('**Core Tech**: Uses `commander` for CLI parsing')).toEqual([
      { kind: 'bold', text: 'Core Tech' },
      { kind: 'text', text: ': Uses ' },
      { kind: 'code', text: 'commander' },
      { kind: 'text', text: ' for CLI parsing' },
    ]);
  });

  it('leaves unclosed markers as plain text', () => {
    expect(parseInline('hello **world')).toEqual([
      { kind: 'text', text: 'hello **world' },
    ]);
  });

  it('does not treat * adjacent to space as italic', () => {
    expect(parseInline('5 * 3 = 15')).toEqual([
      { kind: 'text', text: '5 * 3 = 15' },
    ]);
  });

  it('parses [text](url) as a link span', () => {
    expect(parseInline('see [the docs](https://example.com)')).toEqual([
      { kind: 'text', text: 'see ' },
      { kind: 'link', text: 'the docs', url: 'https://example.com' },
    ]);
  });

  it('leaves bare brackets alone when not followed by (url)', () => {
    expect(parseInline('an [array] of values')).toEqual([
      { kind: 'text', text: 'an [array] of values' },
    ]);
  });

  it('parses ***triple-asterisk*** as bold without leftover stars', () => {
    expect(parseInline('***Heading***')).toEqual([
      { kind: 'bold', text: 'Heading' },
    ]);
    expect(parseInline('a ***strong*** word')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'bold', text: 'strong' },
      { kind: 'text', text: ' word' },
    ]);
  });

  it('parses arbitrary-length asterisk runs (4+) as bold', () => {
    expect(parseInline('****quad****')).toEqual([
      { kind: 'bold', text: 'quad' },
    ]);
    expect(parseInline('*****five*****')).toEqual([
      { kind: 'bold', text: 'five' },
    ]);
  });

  it('handles mismatched-count asterisk runs (3 leading, 2 trailing)', () => {
    expect(parseInline('***Section**')).toEqual([
      { kind: 'bold', text: 'Section' },
    ]);
  });

  it('parses links mixed with bold and code', () => {
    expect(
      parseInline('**bold** then [link](u) and `code`'),
    ).toEqual([
      { kind: 'bold', text: 'bold' },
      { kind: 'text', text: ' then ' },
      { kind: 'link', text: 'link', url: 'u' },
      { kind: 'text', text: ' and ' },
      { kind: 'code', text: 'code' },
    ]);
  });
});
