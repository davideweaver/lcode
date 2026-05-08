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
});
