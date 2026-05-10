import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildSystemPrompt } from '../src/prompts/system.js';
import { defaultAgentFiles } from '../src/prompts/agents.js';
import type { Tool } from '../src/tools/types.js';

const FAKE_TOOL: Tool = {
  name: 'Read',
  description: 'Read a file',
  inputSchema: z.object({}),
  readOnly: true,
  handler: async () => ({ content: 'noop' }),
};

const BASE_ARGS = {
  cwd: '/tmp/example',
  tools: [FAKE_TOOL],
} as const;

describe('buildSystemPrompt', () => {
  it('renders the four agent sections in the documented order', () => {
    const out = buildSystemPrompt({ ...BASE_ARGS });
    const order = [
      '# Persona',
      '# Human',
      '# Capabilities',
      '# Environment',
      '# Tools',
      '# Instructions',
    ];
    let cursor = 0;
    for (const header of order) {
      const idx = out.indexOf(header, cursor);
      expect(idx, `expected "${header}" after position ${cursor}`).toBeGreaterThan(-1);
      cursor = idx + header.length;
    }
  });

  it('uses default agent content when no agentFiles supplied', () => {
    const out = buildSystemPrompt({ ...BASE_ARGS });
    const defaults = defaultAgentFiles();
    expect(out).toContain(defaults.persona);
    expect(out).toContain(defaults.human);
    expect(out).toContain(defaults.capabilities);
    expect(out).toContain(defaults.instructions);
  });

  it('preserves the legacy IDENTITY paragraph as the persona default', () => {
    const out = buildSystemPrompt({ ...BASE_ARGS });
    expect(out).toContain('You are lcode, a local coding assistant');
    expect(out).toContain('You are not Claude. Be honest about that if asked.');
  });

  it('preserves the legacy STYLE bullets as the instructions default', () => {
    const out = buildSystemPrompt({ ...BASE_ARGS });
    expect(out).toContain("- Be terse. State what you're doing");
    expect(out).toContain('- When you reference code, cite as path:line');
  });

  it('substitutes caller-supplied agent content', () => {
    const out = buildSystemPrompt({
      ...BASE_ARGS,
      agentFiles: {
        persona: 'I am Frank.',
        human: 'Dave is the user.',
        capabilities: 'I can yell.',
        instructions: '- Yell only.',
      },
    });
    expect(out).toContain('# Persona\nI am Frank.');
    expect(out).toContain('# Human\nDave is the user.');
    expect(out).toContain('# Capabilities\nI can yell.');
    expect(out).toContain('# Instructions\n- Yell only.');
    // legacy default content must be gone
    expect(out).not.toContain('You are lcode, a local coding assistant');
  });

  it('places # Plan mode active between # Tools and # Instructions', () => {
    const out = buildSystemPrompt({ ...BASE_ARGS, permissionMode: 'plan' });
    const tools = out.indexOf('# Tools');
    const plan = out.indexOf('# Plan mode active');
    const instructions = out.indexOf('# Instructions');
    expect(tools).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(tools);
    expect(instructions).toBeGreaterThan(plan);
  });

  it('omits # Plan mode active when not in plan mode', () => {
    const out = buildSystemPrompt({ ...BASE_ARGS });
    expect(out).not.toContain('# Plan mode active');
  });

  it('appends # User instructions only when customSystemPrompt is set', () => {
    const without = buildSystemPrompt({ ...BASE_ARGS });
    expect(without).not.toContain('# User instructions');
    const withIt = buildSystemPrompt({
      ...BASE_ARGS,
      customSystemPrompt: 'be concise',
    });
    expect(withIt).toContain('# User instructions\nbe concise');
  });
});
