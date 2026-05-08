import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionFilePath } from '../src/core/session.js';
import {
  formatBytes,
  listSessions,
  relativeTime,
} from '../src/core/sessions.js';
import type { SDKMessage } from '../src/core/messages.js';
import { messagesToBlocks } from '../src/tui/replay.js';

async function writeSession(
  cwd: string,
  sessionId: string,
  messages: SDKMessage[],
): Promise<void> {
  const path = sessionFilePath(sessionId, cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    messages.map((m) => JSON.stringify(m)).join('\n') + '\n',
    'utf8',
  );
}

describe('listSessions', () => {
  it('returns empty for a cwd with no sessions', async () => {
    const fakeCwd = `/tmp/lcode-test-empty-${Date.now()}-${Math.random()}`;
    expect(await listSessions(fakeCwd)).toEqual([]);
  });

  it('returns sessions sorted newest first with extracted titles', async () => {
    const cwd = `/tmp/lcode-test-list-${Date.now()}-${Math.random()}`;
    await writeSession(cwd, 'sess-old', [
      {
        type: 'user',
        session_id: 'sess-old',
        message: { role: 'user', content: [{ type: 'text', text: 'old prompt' }] },
      },
      {
        type: 'result',
        session_id: 'sess-old',
        subtype: 'success',
        duration_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);
    // ensure mtime ordering
    await new Promise((r) => setTimeout(r, 20));
    await writeSession(cwd, 'sess-new', [
      {
        type: 'user',
        session_id: 'sess-new',
        message: { role: 'user', content: [{ type: 'text', text: 'newer prompt' }] },
      },
      {
        type: 'result',
        session_id: 'sess-new',
        subtype: 'success',
        duration_ms: 100,
        num_turns: 1,
        total_cost_usd: 0,
      },
    ]);

    const sessions = await listSessions(cwd);
    expect(sessions.map((s) => s.sessionId)).toEqual(['sess-new', 'sess-old']);
    expect(sessions[0]?.title).toBe('newer prompt');
    expect(sessions[1]?.title).toBe('old prompt');
    expect(sessions[0]?.turns).toBe(1);
  });

  it('formats relative times', () => {
    const now = 1_700_000_000_000;
    expect(relativeTime(now - 5_000, now)).toMatch(/5s ago/);
    expect(relativeTime(now - 90_000, now)).toMatch(/minute/);
    expect(relativeTime(now - 7_200_000, now)).toMatch(/hours? ago/);
    expect(relativeTime(now - 90_000_000, now)).toMatch(/day/);
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(2_500_000)).toBe('2.4MB');
  });
});

describe('messagesToBlocks (replay)', () => {
  it('rebuilds user/assistant text and tool_call/tool_result pairs', () => {
    const messages: SDKMessage[] = [
      {
        type: 'system',
        subtype: 'init',
        session_id: 's',
        cwd: '/x',
        model: 'm',
        tools: [],
      },
      {
        type: 'user',
        session_id: 's',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        session_id: 's',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
          ],
          model: 'm',
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'user',
        session_id: 's',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'file body' },
          ],
        },
      },
      {
        type: 'assistant',
        session_id: 's',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          model: 'm',
          stop_reason: 'end_turn',
        },
      },
    ];

    const blocks = messagesToBlocks(messages);
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatchObject({ kind: 'user_prompt', text: 'hi' });
    expect(blocks[1]).toMatchObject({ kind: 'assistant_text', text: 'reading' });
    expect(blocks[2]).toMatchObject({
      kind: 'tool_call',
      name: 'Read',
      status: 'done',
      result: 'file body',
    });
    expect(blocks[3]).toMatchObject({ kind: 'assistant_text', text: 'done' });
  });
});
