import { platform, release } from 'node:os';
import type { Tool } from '../tools/types.js';
import { renderClaudeMdSection, type ClaudeMdFile } from './claudemd.js';

export interface SystemPromptArgs {
  cwd: string;
  tools: Tool[];
  customSystemPrompt?: string;
  permissionMode?: string;
  /** Loaded CLAUDE.md files (user + project + ancestor dirs). */
  claudeMdFiles?: ClaudeMdFile[];
}

/**
 * Build a Claude-Code-style system prompt: identity + environment + tool guidance.
 * Tool *schemas* are sent separately via the OpenAI tools[] field, so we don't
 * repeat them here — just guidance about WHEN to use each tool.
 */
export function buildSystemPrompt(args: SystemPromptArgs): string {
  const sections: string[] = [];

  sections.push(IDENTITY);
  sections.push(buildEnvironment(args));
  sections.push(buildToolGuidance(args.tools));
  if (args.permissionMode === 'plan') sections.push(PLAN_MODE);
  sections.push(STYLE);

  if (args.claudeMdFiles && args.claudeMdFiles.length > 0) {
    sections.push(renderClaudeMdSection(args.claudeMdFiles));
  }

  if (args.customSystemPrompt) {
    sections.push('# User instructions\n' + args.customSystemPrompt.trim());
  }

  return sections.filter(Boolean).join('\n\n');
}

const IDENTITY = `You are lcode, a local coding assistant running on a small open-weight model. \
You behave like Claude Code: you read and edit files, run shell commands, and search the codebase to complete software engineering tasks. \
You are not Claude. Be honest about that if asked.`;

function buildEnvironment(args: SystemPromptArgs): string {
  return [
    '# Environment',
    `- Working directory: ${args.cwd}`,
    `- Platform: ${platform()} ${release()}`,
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
  ].join('\n');
}

function buildToolGuidance(tools: Tool[]): string {
  const lines: string[] = ['# Tools', 'You have these tools. Use them deliberately.'];
  for (const t of tools) {
    lines.push(`- **${t.name}** — ${shorten(t.description)}`);
  }
  lines.push(
    '',
    'Rules:',
    '- File paths for Read/Write/Edit must be **absolute**. Use Glob first if you only know a name.',
    '- You **must** Read a file before Edit-ing or Write-ing over it.',
    '- For Edit, make `old_string` unique by including surrounding context, or set `replace_all: true`.',
    '- For Bash, prefer dedicated tools (Read/Write/Edit/Glob/Grep) when one fits. Reserve Bash for actual shell work.',
    '- When you have everything you need, stop calling tools and answer the user.',
  );
  return lines.join('\n');
}

const PLAN_MODE = `# Plan mode active
You may only read and search. Do not Write, Edit, or run Bash. Produce a plan, then stop.`;

const STYLE = `# Style
- Be terse. State what you're doing in one short sentence before tool calls when useful.
- Don't narrate internal deliberation. Don't summarize what just happened — the user can see the tool results.
- When you reference code, cite as path:line so the user can navigate.`;

function shorten(s: string, max = 160): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + '…';
}
