import { describe, expect, it } from 'vitest';
import { parseMcpName } from '../src/tui/blocks.js';

describe('parseMcpName', () => {
  it('returns null for non-MCP names', () => {
    expect(parseMcpName('Read')).toBeNull();
    expect(parseMcpName('Edit')).toBeNull();
    expect(parseMcpName('something_else')).toBeNull();
  });

  it('splits mcp__server__tool', () => {
    expect(parseMcpName('mcp__context7__resolve-library-id')).toEqual({
      server: 'context7',
      tool: 'resolve-library-id',
    });
    expect(parseMcpName('mcp__xerro__memory_search')).toEqual({
      server: 'xerro',
      tool: 'memory_search',
    });
  });

  it('keeps __ inside the tool name segment', () => {
    expect(parseMcpName('mcp__a__some__tool')).toEqual({
      server: 'a',
      tool: 'some__tool',
    });
  });

  it('returns null for malformed names', () => {
    expect(parseMcpName('mcp__missing-tool')).toBeNull();
    expect(parseMcpName('mcp__')).toBeNull();
    expect(parseMcpName('mcp__server__')).toEqual({ server: 'server', tool: '' });
  });
});
