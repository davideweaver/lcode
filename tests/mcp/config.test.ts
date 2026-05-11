import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpServers, scopeFromSource } from '../../src/mcp/config.js';

async function setup(): Promise<{
  home: string;
  projectRoot: string;
  subDir: string;
}> {
  const tmp = await mkdtemp(join(tmpdir(), 'lcode-mcp-'));
  const home = join(tmp, 'home');
  const projectRoot = join(tmp, 'project');
  const subDir = join(projectRoot, 'sub');
  await mkdir(home, { recursive: true });
  await mkdir(subDir, { recursive: true });
  await mkdir(join(projectRoot, '.git'), { recursive: true });
  return { home, projectRoot, subDir };
}

describe('loadMcpServers', () => {
  it('returns empty when no config files exist', async () => {
    const { home, subDir } = await setup();
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers).toEqual([]);
  });

  it('infers stdio from `command` when type is omitted', async () => {
    const { home, projectRoot, subDir } = await setup();
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          sentry: { command: 'npx', args: ['-y', 'mcp-remote@latest', 'https://x'] },
        },
      }),
      'utf8',
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers).toHaveLength(1);
    expect(servers[0].config).toEqual({
      type: 'stdio',
      name: 'sentry',
      command: 'npx',
      args: ['-y', 'mcp-remote@latest', 'https://x'],
    });
  });

  it('records the absolute path of the file each server was loaded from', async () => {
    const { home, projectRoot, subDir } = await setup();
    await mkdir(join(home, '.lcode'), { recursive: true });
    const lcodePath = join(home, '.lcode', 'mcp.json');
    const projectPath = join(projectRoot, '.mcp.json');
    await writeFile(
      lcodePath,
      JSON.stringify({ mcpServers: { fromUser: { type: 'http', url: 'http://1' } } }),
    );
    await writeFile(
      projectPath,
      JSON.stringify({ mcpServers: { fromProj: { type: 'http', url: 'http://2' } } }),
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    const byName = Object.fromEntries(servers.map((s) => [s.config.name, s]));
    expect(byName.fromUser.source).toBe(lcodePath);
    expect(byName.fromProj.source).toBe(projectPath);
  });

  it('respects explicit type=http and type=sse', async () => {
    const { home, projectRoot, subDir } = await setup();
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
          xerro: { type: 'sse', url: 'http://localhost:9205/mcp' },
        },
      }),
      'utf8',
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    const byName = Object.fromEntries(servers.map((s) => [s.config.name, s.config]));
    expect(byName.context7).toMatchObject({ type: 'http', url: 'https://mcp.context7.com/mcp' });
    expect(byName.xerro).toMatchObject({ type: 'sse', url: 'http://localhost:9205/mcp' });
  });

  it('lcode user file beats project file beats Claude Code fallback', async () => {
    const { home, projectRoot, subDir } = await setup();
    await mkdir(join(home, '.lcode'), { recursive: true });
    // All three define `shared` with different urls; lcode should win.
    await writeFile(
      join(home, '.lcode', 'mcp.json'),
      JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'http://lcode' } } }),
    );
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'http://project' } } }),
    );
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'http://claude' } } }),
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers).toHaveLength(1);
    expect(servers[0].config).toMatchObject({ name: 'shared', url: 'http://lcode' });
    expect(servers[0].source).toBe(join(home, '.lcode', 'mcp.json'));
  });

  it('project file beats Claude Code fallback when lcode file is absent', async () => {
    const { home, projectRoot, subDir } = await setup();
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { sh: { type: 'http', url: 'http://project' } } }),
    );
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { sh: { type: 'http', url: 'http://claude' } } }),
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers[0].config).toMatchObject({ url: 'http://project' });
  });

  it('reads Claude Code fallback when nothing else is present', async () => {
    const { home, subDir } = await setup();
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { foo: { type: 'http', url: 'http://x' } } }),
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers).toHaveLength(1);
    expect(servers[0].config).toEqual({ type: 'http', name: 'foo', url: 'http://x' });
    expect(servers[0].source).toBe(join(home, '.claude.json'));
  });

  it('drops invalid entries with a warning but keeps the rest', async () => {
    const { home, projectRoot, subDir } = await setup();
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { type: 'http', url: 'http://good' },
          // missing 'command'
          bad: { type: 'stdio' },
          // missing 'url'
          alsoBad: { type: 'http' },
          // unknown type
          weird: { type: 'mystery', foo: 'bar' },
        },
      }),
    );
    const warnings: string[] = [];
    const servers = await loadMcpServers(subDir, {
      homeDir: home,
      onWarn: (m) => warnings.push(m),
    });
    expect(servers.map((s) => s.config.name)).toEqual(['good']);
    expect(warnings.length).toBe(3);
    expect(warnings.join('\n')).toMatch(/bad/);
  });

  it('treats streamable-http as http', async () => {
    const { home, projectRoot, subDir } = await setup();
    await writeFile(
      join(projectRoot, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          c: { type: 'streamable-http', url: 'http://x' },
        },
      }),
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers[0].config).toMatchObject({ type: 'http', url: 'http://x' });
  });
});

describe('scopeFromSource', () => {
  const home = '/home/test';

  it('labels ~/.lcode/mcp.json as user', () => {
    expect(scopeFromSource(join(home, '.lcode', 'mcp.json'), home)).toBe('user');
  });

  it('labels ~/.claude.json as claude', () => {
    expect(scopeFromSource(join(home, '.claude.json'), home)).toBe('claude');
  });

  it('labels project .mcp.json as project', () => {
    expect(scopeFromSource('/repos/myproj/.mcp.json', home)).toBe('project');
  });

  it('returns unknown for null/undefined/empty', () => {
    expect(scopeFromSource(null, home)).toBe('unknown');
    expect(scopeFromSource(undefined, home)).toBe('unknown');
    expect(scopeFromSource('', home)).toBe('unknown');
  });

  it('returns unknown for unrecognized paths', () => {
    expect(scopeFromSource('/etc/something/else.json', home)).toBe('unknown');
  });
});
