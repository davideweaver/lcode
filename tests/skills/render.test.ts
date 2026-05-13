import { describe, expect, it } from 'vitest';
import { renderSkillBody } from '../../src/skills/render.js';
import type { Skill } from '../../src/skills/types.js';

function skill(body: string): Skill {
  return {
    name: 'test',
    scope: 'user',
    source: '/tmp/SKILL.md',
    dir: '/tmp',
    description: '',
    disableModelInvocation: false,
    userInvocable: true,
    body,
  };
}

describe('renderSkillBody', () => {
  it('substitutes $ARGUMENTS once', () => {
    expect(renderSkillBody(skill('Hello $ARGUMENTS!'), 'Dave')).toBe('Hello Dave!');
  });

  it('substitutes $ARGUMENTS multiple times', () => {
    expect(renderSkillBody(skill('$ARGUMENTS / $ARGUMENTS'), 'x')).toBe('x / x');
  });

  it('passes through when no placeholder', () => {
    expect(renderSkillBody(skill('No placeholder.'), 'ignored')).toBe('No placeholder.');
  });

  it('handles empty args', () => {
    expect(renderSkillBody(skill('Hello $ARGUMENTS!'), '')).toBe('Hello !');
  });
});
