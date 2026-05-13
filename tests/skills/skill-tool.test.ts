import { describe, expect, it } from 'vitest';
import { makeSkillTool } from '../../src/tools/builtin/skill.js';
import type { Skill } from '../../src/skills/types.js';
import type { ToolContext, ToolResult } from '../../src/tools/types.js';
import { newSessionState } from '../../src/tools/types.js';

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'hello',
    scope: 'user',
    source: '/tmp/SKILL.md',
    dir: '/tmp',
    description: 'Greet user',
    disableModelInvocation: false,
    userInvocable: true,
    body: 'Greet $ARGUMENTS warmly.',
    ...overrides,
  };
}

const fakeCtx: ToolContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  sessionState: newSessionState(),
};

async function invoke(tool: ReturnType<typeof makeSkillTool>, input: object): Promise<ToolResult> {
  const parsed = tool.inputSchema.parse(input);
  return Promise.resolve(tool.handler(parsed, fakeCtx));
}

describe('makeSkillTool', () => {
  it('returns rendered body for a known skill', async () => {
    const tool = makeSkillTool([skill()]);
    const result = await invoke(tool, { skill_name: 'hello', args: 'Dave' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('Greet Dave warmly.');
  });

  it('substitutes empty string when args omitted', async () => {
    const tool = makeSkillTool([skill()]);
    const result = await invoke(tool, { skill_name: 'hello' });
    expect(result.content).toBe('Greet  warmly.');
  });

  it('returns isError for unknown skill name', async () => {
    const tool = makeSkillTool([skill()]);
    const result = await invoke(tool, { skill_name: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown skill');
    expect(result.content).toContain('hello');
  });

  it('refuses skills with disable-model-invocation', async () => {
    const tool = makeSkillTool([skill({ disableModelInvocation: true })]);
    const result = await invoke(tool, { skill_name: 'hello' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('user-invocable only');
  });

  it('lists "(none)" hint when registry is empty', async () => {
    const tool = makeSkillTool([]);
    const result = await invoke(tool, { skill_name: 'anything' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('(none)');
  });
});
