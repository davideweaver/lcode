import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSkills } from '../../src/skills/loader.js';

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'lcode-skills-'));
}

async function makeSkill(
  baseDir: string,
  name: string,
  frontmatter: Record<string, unknown> | null,
  body: string,
): Promise<void> {
  const dir = join(baseDir, name);
  await mkdir(dir, { recursive: true });
  let raw = '';
  if (frontmatter !== null) {
    const fmLines = Object.entries(frontmatter).map(([k, v]) => {
      if (typeof v === 'boolean') return `${k}: ${v}`;
      if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${JSON.stringify(v)}`;
    });
    raw = `---\n${fmLines.join('\n')}\n---\n${body}`;
  } else {
    raw = body;
  }
  await writeFile(join(dir, 'SKILL.md'), raw, 'utf8');
}

describe('loadSkills', () => {
  it('returns empty when neither scope has skills', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills).toEqual([]);
  });

  it('discovers user-scope skills', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(home, '.lcode', 'skills'), 'hello', { description: 'Greet user' }, 'Body!');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('hello');
    expect(skills[0]?.scope).toBe('user');
    expect(skills[0]?.description).toBe('Greet user');
    expect(skills[0]?.body.trim()).toBe('Body!');
  });

  it('discovers project-scope skills', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(cwd, '.claude', 'skills'), 'hello', { description: 'Project greet' }, 'P!');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.scope).toBe('project');
  });

  it('project beats user on name collision', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(home, '.lcode', 'skills'), 'shared', { description: 'user version' }, 'U');
    await makeSkill(join(cwd, '.claude', 'skills'), 'shared', { description: 'project version' }, 'P');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.scope).toBe('project');
    expect(skills[0]?.description).toBe('project version');
  });

  it('accepts skill with no frontmatter (defaults applied)', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(home, '.lcode', 'skills'), 'bare', null, 'Plain body');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe('bare');
    expect(skills[0]?.description).toBe('');
    expect(skills[0]?.disableModelInvocation).toBe(false);
    expect(skills[0]?.userInvocable).toBe(true);
  });

  it('reads disable-model-invocation and user-invocable flags', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(
      join(home, '.lcode', 'skills'),
      'gated',
      { description: 'gated', 'disable-model-invocation': true, 'user-invocable': false },
      'Body',
    );
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills[0]?.disableModelInvocation).toBe(true);
    expect(skills[0]?.userInvocable).toBe(false);
  });

  it('sorts by name', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(home, '.lcode', 'skills'), 'zeta', { description: 'z' }, 'z');
    await makeSkill(join(home, '.lcode', 'skills'), 'alpha', { description: 'a' }, 'a');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('strips frontmatter from body', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(home, '.lcode', 'skills'), 'fm', { description: 'd' }, 'Just the body.');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills[0]?.body).not.toContain('description');
    expect(skills[0]?.body.trim()).toBe('Just the body.');
  });

  it('honors explicit name override in frontmatter', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await makeSkill(join(home, '.lcode', 'skills'), 'dir-name', { name: 'xerro:notes', description: 'd' }, 'B');
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills[0]?.name).toBe('xerro:notes');
  });

  it('skips directories without SKILL.md', async () => {
    const home = await tempDir();
    const cwd = await tempDir();
    await mkdir(join(home, '.lcode', 'skills', 'empty'), { recursive: true });
    const skills = await loadSkills(cwd, { homeDir: home, onWarn: () => {} });
    expect(skills).toEqual([]);
  });
});
