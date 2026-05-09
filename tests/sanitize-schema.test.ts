import { describe, expect, it } from 'vitest';
import { sanitizeSchemaForLlm } from '../src/core/llm.js';

describe('sanitizeSchemaForLlm', () => {
  it('passes scalar types through unchanged', () => {
    const s = { type: 'object', properties: { name: { type: 'string' } } };
    expect(sanitizeSchemaForLlm(s)).toEqual(s);
  });

  it('collapses ["string","null"] to type:string + nullable:true', () => {
    const out = sanitizeSchemaForLlm({ type: ['string', 'null'] });
    expect(out).toEqual({ type: 'string', nullable: true });
  });

  it('collapses ["null","number"] to type:number + nullable:true', () => {
    const out = sanitizeSchemaForLlm({ type: ['null', 'number'] });
    expect(out).toEqual({ type: 'number', nullable: true });
  });

  it('picks the first type when none is null', () => {
    const out = sanitizeSchemaForLlm({ type: ['string', 'integer'] });
    expect(out).toEqual({ type: 'string' });
  });

  it('recurses into properties', () => {
    const out = sanitizeSchemaForLlm({
      type: 'object',
      properties: {
        a: { type: ['string', 'null'] },
        b: { type: 'integer' },
      },
    });
    expect(out).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string', nullable: true },
        b: { type: 'integer' },
      },
    });
  });

  it('recurses into items / arrays / oneOf', () => {
    const out = sanitizeSchemaForLlm({
      type: 'array',
      items: { type: ['string', 'null'] },
      oneOf: [{ type: ['number', 'null'] }, { type: 'boolean' }],
    });
    expect(out).toEqual({
      type: 'array',
      items: { type: 'string', nullable: true },
      oneOf: [{ type: 'number', nullable: true }, { type: 'boolean' }],
    });
  });

  it('does not mutate input', () => {
    const input = { type: ['string', 'null'] };
    sanitizeSchemaForLlm(input);
    expect(input).toEqual({ type: ['string', 'null'] });
  });

  it('returns primitives unchanged', () => {
    expect(sanitizeSchemaForLlm(null)).toBe(null);
    expect(sanitizeSchemaForLlm('hi')).toBe('hi');
    expect(sanitizeSchemaForLlm(42)).toBe(42);
  });
});
