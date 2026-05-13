import { z } from 'zod';
import { tool } from '../helper.js';
import type { Tool } from '../types.js';
import { renderSkillBody } from '../../skills/render.js';
import type { Skill } from '../../skills/types.js';

const schema = z.object({
  skill_name: z.string().describe('Skill name as shown in the system prompt.'),
  args: z
    .string()
    .optional()
    .describe('Arguments substituted into the skill body via $ARGUMENTS.'),
});

/**
 * Factory for the `Skill` tool. The tool is session-scoped — bound to the
 * specific enabled skill list at the time `query()` runs — so we hand it a
 * name map and let unknown invocations return an isError result with a hint.
 */
export function makeSkillTool(skills: Skill[]): Tool {
  const byName = new Map<string, Skill>(skills.map((s) => [s.name, s]));
  const knownList = skills.map((s) => s.name).join(', ') || '(none)';
  return tool(
    'Skill',
    'Invoke a named skill (a reusable workflow). Returns the skill\'s full instructions, which you should then follow on subsequent turns.',
    schema,
    (input) => {
      const skill = byName.get(input.skill_name);
      if (!skill) {
        return {
          content: `Unknown skill "${input.skill_name}". Known skills: ${knownList}`,
          isError: true,
        };
      }
      if (skill.disableModelInvocation) {
        return {
          content: `Skill "${skill.name}" is user-invocable only and cannot be triggered by the model.`,
          isError: true,
        };
      }
      return { content: renderSkillBody(skill, input.args ?? '') };
    },
    { readOnly: true },
  );
}
