import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadClaudeMdFiles,
  renderClaudeMdSection,
} from '../src/prompts/claudemd.js';

async function setupTempProject(): Promise<{
  home: string;
  projectRoot: string;
  subDir: string;
}> {
  const tmp = await mkdtemp(join(tmpdir(), 'lcode-claudemd-'));
  const home = join(tmp, 'home');
  const projectRoot = join(tmp, 'project');
  const subDir = join(projectRoot, 'packages', 'foo');
  await mkdir(home, { recursive: true });
  await mkdir(subDir, { recursive: true });
  // Make project a git root
  await mkdir(join(projectRoot, '.git'), { recursive: true });
  return { home, projectRoot, subDir };
}

describe('loadClaudeMdFiles', () => {
  it('returns empty when no CLAUDE.md anywhere', async () => {
    const { home, subDir } = await setupTempProject();
    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files).toEqual([]);
  });

  it('loads user-level ~/.claude/CLAUDE.md', async () => {
    const { home, subDir } = await setupTempProject();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'user rules', 'utf8');
    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files).toHaveLength(1);
    expect(files[0]?.source).toBe('user');
    expect(files[0]?.content).toBe('user rules');
  });

  it('walks up from cwd to git root collecting CLAUDE.md', async () => {
    const { home, projectRoot, subDir } = await setupTempProject();
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'project rules', 'utf8');
    await writeFile(join(subDir, 'CLAUDE.md'), 'subdir rules', 'utf8');

    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files.map((f) => f.source)).toEqual(['project', 'directory']);
    expect(files[0]?.path).toBe(join(projectRoot, 'CLAUDE.md'));
    expect(files[1]?.path).toBe(join(subDir, 'CLAUDE.md'));
  });

  it('orders user → project → ancestor dirs', async () => {
    const { home, projectRoot, subDir } = await setupTempProject();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'CLAUDE.md'), 'user', 'utf8');
    await writeFile(join(projectRoot, 'CLAUDE.md'), 'project', 'utf8');
    await writeFile(join(subDir, 'CLAUDE.md'), 'subdir', 'utf8');

    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files.map((f) => f.source)).toEqual(['user', 'project', 'directory']);
    expect(files.map((f) => f.content)).toEqual(['user', 'project', 'subdir']);
  });

  it('falls back to cwd when there is no git root', async () => {
    const { home } = await setupTempProject();
    const noGit = await mkdtemp(join(tmpdir(), 'lcode-nogit-'));
    await writeFile(join(noGit, 'CLAUDE.md'), 'standalone', 'utf8');
    const files = await loadClaudeMdFiles(noGit, { homeDir: home });
    expect(files).toHaveLength(1);
    expect(files[0]?.source).toBe('project');
  });

  it('expands @relative imports', async () => {
    const { home, projectRoot, subDir } = await setupTempProject();
    await writeFile(join(projectRoot, 'rules.md'), 'extra rules', 'utf8');
    await writeFile(
      join(projectRoot, 'CLAUDE.md'),
      'before\n@rules.md\nafter',
      'utf8',
    );
    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files[0]?.content).toBe('before\nextra rules\nafter');
  });

  it('expands @~/path imports', async () => {
    const { home, subDir } = await setupTempProject();
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(join(home, '.claude', 'snippet.md'), 'home snippet', 'utf8');
    await writeFile(
      join(subDir, 'CLAUDE.md'),
      'top\n@~/.claude/snippet.md\nend',
      'utf8',
    );
    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files[0]?.content).toContain('home snippet');
  });

  it('leaves unresolved @imports as plain text', async () => {
    const { home, subDir } = await setupTempProject();
    await writeFile(join(subDir, 'CLAUDE.md'), 'pre\n@nope.md\npost', 'utf8');
    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files[0]?.content).toBe('pre\n@nope.md\npost');
  });

  it('does not mistake inline @ for an import', async () => {
    const { home, subDir } = await setupTempProject();
    await writeFile(
      join(subDir, 'CLAUDE.md'),
      'email me at bob@example.com please',
      'utf8',
    );
    const files = await loadClaudeMdFiles(subDir, { homeDir: home });
    expect(files[0]?.content).toBe('email me at bob@example.com please');
  });
});

describe('renderClaudeMdSection', () => {
  it('returns empty string for no files', () => {
    expect(renderClaudeMdSection([])).toBe('');
  });

  it('formats with the IMPORTANT preamble + Contents-of blocks', () => {
    const out = renderClaudeMdSection([
      { path: '/x/CLAUDE.md', source: 'project', content: 'project rules' },
    ]);
    expect(out).toContain('# claudeMd');
    expect(out).toMatch(/IMPORTANT: These instructions OVERRIDE/);
    expect(out).toContain(
      'Contents of /x/CLAUDE.md (project instructions, checked into the codebase):',
    );
    expect(out).toContain('project rules');
  });

  it('uses correct descriptors per source', () => {
    const out = renderClaudeMdSection([
      { path: '/u', source: 'user', content: 'u' },
      { path: '/p', source: 'project', content: 'p' },
      { path: '/d', source: 'directory', content: 'd' },
    ]);
    expect(out).toContain('(user instructions, applied to all projects)');
    expect(out).toContain('(project instructions, checked into the codebase)');
    expect(out).toContain('(directory-specific instructions)');
  });
});
