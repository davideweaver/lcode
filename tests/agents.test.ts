import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { defaultAgentFiles, loadAgentFiles } from '../src/prompts/agents.js';

async function makeHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'lcode-agents-'));
}

describe('loadAgentFiles', () => {
  it('auto-creates settings.json on first run with all entries disabled', async () => {
    const home = await makeHome();
    const warn = vi.fn();

    const result = await loadAgentFiles({ homeDir: home, onWarn: warn });

    const settingsPath = join(home, '.lcode', 'settings.json');
    const written = JSON.parse(await readFile(settingsPath, 'utf8'));
    expect(written.agentFiles.persona).toEqual({ enabled: false, file: 'PERSONA.md' });
    expect(written.agentFiles.human).toEqual({ enabled: false, file: 'HUMAN.md' });
    expect(written.agentFiles.capabilities).toEqual({ enabled: false, file: 'CAPABILITIES.md' });
    expect(written.agentFiles.instructions).toEqual({ enabled: false, file: 'INSTRUCTIONS.md' });

    expect(result).toEqual(defaultAgentFiles());
    expect(warn).not.toHaveBeenCalled();
  });

  it('ignores existing .md files when entries are disabled', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(join(home, '.lcode', 'PERSONA.md'), 'should be ignored', 'utf8');
    await writeFile(
      join(home, '.lcode', 'settings.json'),
      JSON.stringify({
        agentFiles: {
          persona: { enabled: false, file: 'PERSONA.md' },
          human: { enabled: false, file: 'HUMAN.md' },
          capabilities: { enabled: false, file: 'CAPABILITIES.md' },
          instructions: { enabled: false, file: 'INSTRUCTIONS.md' },
        },
      }),
      'utf8',
    );

    const result = await loadAgentFiles({ homeDir: home });
    expect(result).toEqual(defaultAgentFiles());
  });

  it('reads enabled .md files and trims their content', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(
      join(home, '.lcode', 'PERSONA.md'),
      '\n  You are Frank.  \n',
      'utf8',
    );
    await writeFile(
      join(home, '.lcode', 'settings.json'),
      JSON.stringify({
        agentFiles: {
          persona: { enabled: true, file: 'PERSONA.md' },
          human: { enabled: false, file: 'HUMAN.md' },
          capabilities: { enabled: false, file: 'CAPABILITIES.md' },
          instructions: { enabled: false, file: 'INSTRUCTIONS.md' },
        },
      }),
      'utf8',
    );

    const result = await loadAgentFiles({ homeDir: home });
    expect(result.persona).toBe('You are Frank.');
    const defaults = defaultAgentFiles();
    expect(result.human).toBe(defaults.human);
    expect(result.capabilities).toBe(defaults.capabilities);
    expect(result.instructions).toBe(defaults.instructions);
  });

  it('falls back to default and warns when an enabled file is missing', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(
      join(home, '.lcode', 'settings.json'),
      JSON.stringify({
        agentFiles: {
          persona: { enabled: true, file: 'PERSONA.md' },
          human: { enabled: false, file: 'HUMAN.md' },
          capabilities: { enabled: false, file: 'CAPABILITIES.md' },
          instructions: { enabled: false, file: 'INSTRUCTIONS.md' },
        },
      }),
      'utf8',
    );
    const warn = vi.fn();

    const result = await loadAgentFiles({ homeDir: home, onWarn: warn });

    expect(result.persona).toBe(defaultAgentFiles().persona);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/file not found/);
  });

  it('falls back to default when an enabled file is empty', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(join(home, '.lcode', 'PERSONA.md'), '   \n  ', 'utf8');
    await writeFile(
      join(home, '.lcode', 'settings.json'),
      JSON.stringify({
        agentFiles: {
          persona: { enabled: true, file: 'PERSONA.md' },
          human: { enabled: false, file: 'HUMAN.md' },
          capabilities: { enabled: false, file: 'CAPABILITIES.md' },
          instructions: { enabled: false, file: 'INSTRUCTIONS.md' },
        },
      }),
      'utf8',
    );
    const warn = vi.fn();

    const result = await loadAgentFiles({ homeDir: home, onWarn: warn });
    expect(result.persona).toBe(defaultAgentFiles().persona);
    expect(warn.mock.calls[0]?.[0]).toMatch(/empty/);
  });

  it('warns and uses defaults on malformed JSON without overwriting the file', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    const settingsPath = join(home, '.lcode', 'settings.json');
    const malformed = '{ this is not json';
    await writeFile(settingsPath, malformed, 'utf8');
    const warn = vi.fn();

    const result = await loadAgentFiles({ homeDir: home, onWarn: warn });

    expect(result).toEqual(defaultAgentFiles());
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toMatch(/invalid JSON/);
    // file is unchanged
    const stillThere = await readFile(settingsPath, 'utf8');
    expect(stillThere).toBe(malformed);
  });

  it('honors a custom file name within ~/.lcode/', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    await writeFile(
      join(home, '.lcode', 'alt-persona.md'),
      'You are Alt.',
      'utf8',
    );
    await writeFile(
      join(home, '.lcode', 'settings.json'),
      JSON.stringify({
        agentFiles: {
          persona: { enabled: true, file: 'alt-persona.md' },
          human: { enabled: false, file: 'HUMAN.md' },
          capabilities: { enabled: false, file: 'CAPABILITIES.md' },
          instructions: { enabled: false, file: 'INSTRUCTIONS.md' },
        },
      }),
      'utf8',
    );

    const result = await loadAgentFiles({ homeDir: home });
    expect(result.persona).toBe('You are Alt.');
  });

  it('does not write settings.json when the file already exists', async () => {
    const home = await makeHome();
    await mkdir(join(home, '.lcode'), { recursive: true });
    const settingsPath = join(home, '.lcode', 'settings.json');
    const original = JSON.stringify({ agentFiles: {} });
    await writeFile(settingsPath, original, 'utf8');
    const before = await stat(settingsPath);

    await loadAgentFiles({ homeDir: home });

    const after = await readFile(settingsPath, 'utf8');
    const afterStat = await stat(settingsPath);
    expect(after).toBe(original);
    expect(afterStat.mtimeMs).toBe(before.mtimeMs);
  });
});
