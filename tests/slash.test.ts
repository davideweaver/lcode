import { describe, expect, it } from 'vitest';
import type { LcodeConfig } from '../src/config.js';
import { matchCommands, maybeRunSlashCommand, type SlashContext } from '../src/tui/slash.js';
import type { UiBlock } from '../src/tui/types.js';

function mkCtx(overrides: Partial<SlashContext> = {}): {
  ctx: SlashContext;
  blocks: UiBlock[];
  cleared: { count: number };
  exited: { count: number };
  resumed: { count: number };
  modelPicked: { count: number };
  modelSet: { value: string | null };
} {
  const blocks: UiBlock[] = [];
  const cleared = { count: 0 };
  const exited = { count: 0 };
  const resumed = { count: 0 };
  const modelPicked = { count: 0 };
  const modelSet: { value: string | null } = { value: null };
  const config: LcodeConfig = {
    llmUrl: 'http://localhost:9200',
    model: 'qwen2.5-7b-instruct',
    apiKey: 'sk-not-needed',
    contextWindow: 32_768,
  };
  return {
    blocks,
    cleared,
    exited,
    resumed,
    modelPicked,
    modelSet,
    ctx: {
      cwd: '/tmp/test',
      config,
      sessionId: 'abc-123',
      currentModel: config.model,
      setCurrentModel: (m) => {
        modelSet.value = m;
      },
      addBlock: (b) => blocks.push(b),
      clearSession: () => cleared.count++,
      openResumePicker: () => resumed.count++,
      openModelPicker: () => modelPicked.count++,
      exit: () => exited.count++,
      ...overrides,
    },
  };
}

describe('matchCommands', () => {
  it('returns commands prefixed by query', () => {
    const matches = matchCommands('cl').map((c) => c.name);
    expect(matches).toContain('clear');
  });

  it('is case-insensitive', () => {
    const matches = matchCommands('HE').map((c) => c.name);
    expect(matches).toContain('help');
  });

  it('returns empty for no match', () => {
    expect(matchCommands('zzznothing')).toHaveLength(0);
  });

  it('returns all commands for empty query', () => {
    expect(matchCommands('').length).toBeGreaterThan(0);
  });
});

describe('maybeRunSlashCommand', () => {
  it('returns false for non-slash input (passes through to LLM)', async () => {
    const { ctx } = mkCtx();
    expect(await maybeRunSlashCommand('hello world', ctx)).toBe(false);
  });

  it('handles /help by listing commands', async () => {
    const { ctx, blocks } = mkCtx();
    const handled = await maybeRunSlashCommand('/help', ctx);
    expect(handled).toBe(true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'slash_output' });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('/help');
    expect(text).toContain('/clear');
  });

  it('handles /clear by invoking clearSession', async () => {
    const { ctx, cleared, blocks } = mkCtx();
    await maybeRunSlashCommand('/clear', ctx);
    expect(cleared.count).toBe(1);
    expect(blocks[0]).toMatchObject({ kind: 'slash_output' });
  });

  it('handles /exit', async () => {
    const { ctx, exited } = mkCtx();
    await maybeRunSlashCommand('/exit', ctx);
    expect(exited.count).toBe(1);
  });

  it('handles /resume by opening the picker', async () => {
    const { ctx, resumed } = mkCtx();
    await maybeRunSlashCommand('/resume', ctx);
    expect(resumed.count).toBe(1);
  });

  it('handles /cwd', async () => {
    const { ctx, blocks } = mkCtx();
    await maybeRunSlashCommand('/cwd', ctx);
    expect(blocks[0]).toMatchObject({
      kind: 'slash_output',
      text: '/tmp/test',
    });
  });

  it('reports unknown command', async () => {
    const { ctx, blocks } = mkCtx();
    await maybeRunSlashCommand('/notreal', ctx);
    expect((blocks[0] as { text: string }).text).toMatch(/Unknown command/);
  });

  it('eats bare slash without erroring', async () => {
    const { ctx, blocks } = mkCtx();
    expect(await maybeRunSlashCommand('/', ctx)).toBe(true);
    expect(blocks).toHaveLength(0);
  });

  it('handles bare /model by showing current model and opening the picker', async () => {
    const { ctx, blocks, modelPicked, modelSet } = mkCtx();
    await maybeRunSlashCommand('/model', ctx);
    expect(modelPicked.count).toBe(1);
    expect(modelSet.value).toBeNull();
    expect((blocks[0] as { text: string }).text).toContain('qwen2.5-7b-instruct');
  });

  it('handles /model <name> by setting the model directly', async () => {
    const { ctx, blocks, modelPicked, modelSet } = mkCtx();
    await maybeRunSlashCommand('/model llama-3.1-8b', ctx);
    expect(modelSet.value).toBe('llama-3.1-8b');
    expect(modelPicked.count).toBe(0);
    expect((blocks[0] as { text: string }).text).toContain('llama-3.1-8b');
  });
});
