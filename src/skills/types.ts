export type SkillScope = 'project' | 'user';

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  'when-to-use'?: string;
  'argument-hint'?: string;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
}

export interface Skill {
  /** Canonical skill name (lower-kebab; colon-permitted for plugin-style). */
  name: string;
  scope: SkillScope;
  /** Absolute path to the SKILL.md file. */
  source: string;
  /** Absolute path to the skill directory. */
  dir: string;
  description: string;
  whenToUse?: string;
  argumentHint?: string;
  /** When true, the Skill tool refuses this skill (user-invocable only). */
  disableModelInvocation: boolean;
  /** When false, /<name> won't fire this skill from the slash dispatcher. */
  userInvocable: boolean;
  /** SKILL.md content with frontmatter stripped. */
  body: string;
}
