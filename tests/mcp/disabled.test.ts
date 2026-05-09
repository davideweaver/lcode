import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadDisabledServers, setServerDisabled } from '../../src/mcp/disabled.js';

async function tempHome(): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'lcode-disabled-'));
  return tmp;
}

describe('loadDisabledServers', () => {
  it('returns empty when the file does not exist', async () => {
    const home = await tempHome();
    const set = await loadDisabledServers({ homeDir: home, onWarn: () => {} });
    expect(set.size).toBe(0);
  });

  it('returns the disabled list when present', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(
      join(home, '.lcode', 'mcp-disabled.json'),
      JSON.stringify({ disabled: ['a', 'b'] }),
    );
    const set = await loadDisabledServers({ homeDir: home, onWarn: () => {} });
    expect([...set].sort()).toEqual(['a', 'b']);
  });

  it('warns and returns empty on malformed JSON', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(join(home, '.lcode', 'mcp-disabled.json'), '{not json');
    const warnings: string[] = [];
    const set = await loadDisabledServers({ homeDir: home, onWarn: (m) => warnings.push(m) });
    expect(set.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });

  it('returns empty when shape is wrong', async () => {
    const home = await tempHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(join(home, '.lcode', 'mcp-disabled.json'), JSON.stringify(['a', 'b']));
    const warnings: string[] = [];
    const set = await loadDisabledServers({ homeDir: home, onWarn: (m) => warnings.push(m) });
    expect(set.size).toBe(0);
    expect(warnings.length).toBe(1);
  });
});

describe('setServerDisabled', () => {
  it('creates the file and lcode dir on first disable', async () => {
    const home = await tempHome();
    await setServerDisabled('foo', true, { homeDir: home, onWarn: () => {} });
    const set = await loadDisabledServers({ homeDir: home, onWarn: () => {} });
    expect([...set]).toEqual(['foo']);
  });

  it('round-trips disable then enable', async () => {
    const home = await tempHome();
    await setServerDisabled('foo', true, { homeDir: home, onWarn: () => {} });
    await setServerDisabled('bar', true, { homeDir: home, onWarn: () => {} });
    let set = await loadDisabledServers({ homeDir: home, onWarn: () => {} });
    expect([...set].sort()).toEqual(['bar', 'foo']);

    await setServerDisabled('foo', false, { homeDir: home, onWarn: () => {} });
    set = await loadDisabledServers({ homeDir: home, onWarn: () => {} });
    expect([...set]).toEqual(['bar']);
  });

  it('writes a sorted disabled list', async () => {
    const home = await tempHome();
    await setServerDisabled('zeta', true, { homeDir: home, onWarn: () => {} });
    await setServerDisabled('alpha', true, { homeDir: home, onWarn: () => {} });
    const text = await readFile(join(home, '.lcode', 'mcp-disabled.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ disabled: ['alpha', 'zeta'] });
  });

  it('is a no-op when the state already matches', async () => {
    const home = await tempHome();
    await setServerDisabled('foo', true, { homeDir: home, onWarn: () => {} });
    await setServerDisabled('foo', true, { homeDir: home, onWarn: () => {} });
    const set = await loadDisabledServers({ homeDir: home, onWarn: () => {} });
    expect([...set]).toEqual(['foo']);
  });
});
