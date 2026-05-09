import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadMcpServers } from '../../src/mcp/config.js';

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
    expect(servers).toEqual([
      {
        type: 'stdio',
        name: 'sentry',
        command: 'npx',
        args: ['-y', 'mcp-remote@latest', 'https://x'],
      },
    ]);
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
    const byName = Object.fromEntries(servers.map((s) => [s.name, s]));
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
    expect(servers[0]).toMatchObject({ name: 'shared', url: 'http://lcode' });
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
    expect(servers[0]).toMatchObject({ url: 'http://project' });
  });

  it('reads Claude Code fallback when nothing else is present', async () => {
    const { home, subDir } = await setup();
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { foo: { type: 'http', url: 'http://x' } } }),
    );
    const servers = await loadMcpServers(subDir, { homeDir: home, onWarn: () => {} });
    expect(servers).toEqual([{ type: 'http', name: 'foo', url: 'http://x' }]);
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
    expect(servers.map((s) => s.name)).toEqual(['good']);
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
    expect(servers[0]).toMatchObject({ type: 'http', url: 'http://x' });
  });
});
