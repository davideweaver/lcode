import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enabledFilePath, loadEnabled, setEnabled } from '../../src/skills/enabled.js';

async function tempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'lcode-skills-enabled-'));
}

const projectA = '/tmp/lcode-project-a';
const projectB = '/tmp/lcode-project-b';

describe('loadEnabled', () => {
  it('returns empty when the file does not exist', async () => {
    const home = await tempHome();
    const set = await loadEnabled(projectA, { homeDir: home, onWarn: () => {} });
    expect(set.size).toBe(0);
  });

  it('returns empty when project not present in file', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(
      enabledFilePath(home),
      JSON.stringify({ [projectB]: { enabled: ['x'] } }),
    );
    const set = await loadEnabled(projectA, { homeDir: home, onWarn: () => {} });
    expect(set.size).toBe(0);
  });

  it('returns the enabled list when present', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(
      enabledFilePath(home),
      JSON.stringify({ [projectA]: { enabled: ['hello', 'world'] } }),
    );
    const set = await loadEnabled(projectA, { homeDir: home, onWarn: () => {} });
    expect([...set].sort()).toEqual(['hello', 'world']);
  });

  it('warns and returns empty on malformed JSON', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(enabledFilePath(home), '{not json');
    const warnings: string[] = [];
    const set = await loadEnabled(projectA, { homeDir: home, onWarn: (m) => warnings.push(m) });
    expect(set.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe('setEnabled', () => {
  it('creates the file and lcode dir on first enable', async () => {
    const home = await tempHome();
    await setEnabled(projectA, 'hello', true, { homeDir: home, onWarn: () => {} });
    const set = await loadEnabled(projectA, { homeDir: home, onWarn: () => {} });
    expect([...set]).toEqual(['hello']);
  });

  it('round-trips enable then disable', async () => {
    const home = await tempHome();
    await setEnabled(projectA, 'hello', true, { homeDir: home, onWarn: () => {} });
    await setEnabled(projectA, 'world', true, { homeDir: home, onWarn: () => {} });
    let set = await loadEnabled(projectA, { homeDir: home, onWarn: () => {} });
    expect([...set].sort()).toEqual(['hello', 'world']);

    await setEnabled(projectA, 'hello', false, { homeDir: home, onWarn: () => {} });
    set = await loadEnabled(projectA, { homeDir: home, onWarn: () => {} });
    expect([...set]).toEqual(['world']);
  });

  it('writes a sorted enabled list', async () => {
    const home = await tempHome();
    await setEnabled(projectA, 'zeta', true, { homeDir: home, onWarn: () => {} });
    await setEnabled(projectA, 'alpha', true, { homeDir: home, onWarn: () => {} });
    const text = await readFile(enabledFilePath(home), 'utf8');
    expect(JSON.parse(text)).toEqual({ [projectA]: { enabled: ['alpha', 'zeta'] } });
  });

  it('preserves other projects when toggling', async () => {
    const home = await tempHome();
    await setEnabled(projectA, 'hello', true, { homeDir: home, onWarn: () => {} });
    await setEnabled(projectB, 'world', true, { homeDir: home, onWarn: () => {} });
    await setEnabled(projectA, 'goodbye', true, { homeDir: home, onWarn: () => {} });
    const text = await readFile(enabledFilePath(home), 'utf8');
    expect(JSON.parse(text)).toEqual({
      [projectA]: { enabled: ['goodbye', 'hello'] },
      [projectB]: { enabled: ['world'] },
    });
  });

  it('removes the project key when its enabled list becomes empty', async () => {
    const home = await tempHome();
    await setEnabled(projectA, 'hello', true, { homeDir: home, onWarn: () => {} });
    await setEnabled(projectB, 'world', true, { homeDir: home, onWarn: () => {} });
    await setEnabled(projectA, 'hello', false, { homeDir: home, onWarn: () => {} });
    const text = await readFile(enabledFilePath(home), 'utf8');
    expect(JSON.parse(text)).toEqual({ [projectB]: { enabled: ['world'] } });
  });
});
