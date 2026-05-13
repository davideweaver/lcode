import type { Skill } from './types.js';

/**
 * Substitute `$ARGUMENTS` placeholders in a skill body. v1 substitution model:
 * literal string replacement, no shell prefetch, no positional $0/$1.
 */
export function renderSkillBody(skill: Skill, argsString: string): string {
  return skill.body.split('$ARGUMENTS').join(argsString);
}
