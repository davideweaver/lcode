import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EditTool } from '../src/tools/builtin/edit.js';
import { GlobTool } from '../src/tools/builtin/glob.js';
import { ReadTool } from '../src/tools/builtin/read.js';
import { WriteTool } from '../src/tools/builtin/write.js';
import { newSessionState } from '../src/tools/types.js';

function mkCtx(cwd: string) {
  return {
    cwd,
    signal: new AbortController().signal,
    sessionState: newSessionState(),
  };
}

describe('Read', () => {
  it('returns numbered lines and tracks file in sessionState', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'first\nsecond\nthird\n');
    const ctx = mkCtx(dir);
    const result = await ReadTool.handler({ file_path: path }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('     1\tfirst');
    expect(result.content).toContain('     2\tsecond');
    expect(ctx.sessionState.readFiles.has(path)).toBe(true);
  });

  it('rejects relative paths', async () => {
    const ctx = mkCtx(process.cwd());
    const result = await ReadTool.handler({ file_path: 'relative.txt' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/absolute/);
  });
});

describe('Edit "Read first" rule', () => {
  it('refuses Edit if file was not Read in this session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'hello world');
    const ctx = mkCtx(dir);
    const result = await EditTool.handler(
      { file_path: path, old_string: 'hello', new_string: 'goodbye' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/Read .+ before editing/);
  });

  it('allows Edit after Read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'hello world');
    const ctx = mkCtx(dir);
    await ReadTool.handler({ file_path: path }, ctx);
    const result = await EditTool.handler(
      { file_path: path, old_string: 'hello', new_string: 'goodbye' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(path, 'utf8')).toBe('goodbye world');
  });

  it('errors on non-unique old_string without replace_all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'foo foo foo');
    const ctx = mkCtx(dir);
    await ReadTool.handler({ file_path: path }, ctx);
    const r1 = await EditTool.handler(
      { file_path: path, old_string: 'foo', new_string: 'bar' },
      ctx,
    );
    expect(r1.isError).toBe(true);
    expect(r1.content).toMatch(/3 times/);
    const r2 = await EditTool.handler(
      { file_path: path, old_string: 'foo', new_string: 'bar', replace_all: true },
      ctx,
    );
    expect(r2.isError).toBeFalsy();
    expect(await readFile(path, 'utf8')).toBe('bar bar bar');
  });
});

describe('Write "Read first when exists" rule', () => {
  it('refuses overwrite without a prior Read and leaves file untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'line one\nline two\n');
    const ctx = mkCtx(dir);
    const result = await WriteTool.handler({ file_path: path, content: 'new' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('must Read');
    expect(await readFile(path, 'utf8')).toBe('line one\nline two\n');
  });

  it('allows create for new file without Read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'new.txt');
    const ctx = mkCtx(dir);
    const result = await WriteTool.handler({ file_path: path, content: 'fresh' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(await readFile(path, 'utf8')).toBe('fresh');
  });

  it('overwrites after a prior Read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    const path = join(dir, 'a.txt');
    await writeFile(path, 'old');
    const ctx = mkCtx(dir);
    await ReadTool.handler({ file_path: path }, ctx);
    const result = await WriteTool.handler({ file_path: path, content: 'new' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(await readFile(path, 'utf8')).toBe('new');
  });
});

describe('Glob', () => {
  it('matches files by pattern', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lcode-'));
    await writeFile(join(dir, 'a.ts'), '');
    await writeFile(join(dir, 'b.tsx'), '');
    await writeFile(join(dir, 'c.md'), '');
    const ctx = mkCtx(dir);
    const result = await GlobTool.handler({ pattern: '**/*.ts', path: dir }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('a.ts');
    expect(result.content).not.toContain('b.tsx');
    expect(result.content).not.toContain('c.md');
  });
});
