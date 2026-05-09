import { Box, Text, useInput } from 'ink';
import { useMemo, useReducer, useState } from 'react';
import type { Tool } from '../tools/types.js';
import type { ClaudeMdFile } from '../prompts/claudemd.js';
import { renderClaudeMdSection } from '../prompts/claudemd.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { toOpenAITools } from '../core/llm.js';
import { estimateTokens, formatTokenCount, tokenStats } from './tokens.js';
import type { UiBlock } from './types.js';

interface ContextPickerProps {
  blocks: UiBlock[];
  tools: Tool[];
  claudeMdFiles: ClaudeMdFile[] | undefined;
  cwd: string;
  permissionMode?: string;
  customSystemPrompt?: string;
  contextWindow: number;
  /**
   * Server-snapped prompt size — same value the statusline shows. The modal
   * leads with this so the two views agree on the headline number. Local-BPE
   * category estimates appear underneath as a "where it's going" breakdown,
   * with the proxy-vs-server drift surfaced explicitly.
   */
  tokensUsed: number;
  /** Force-compact the session. Wired by app.tsx; bound to `c` in the overview. */
  onCompact: () => void | Promise<void>;
  onCancel: () => void;
}

type View =
  | { kind: 'overview' }
  | { kind: 'per_tool'; idx: number }
  | { kind: 'largest'; idx: number };

interface Breakdown {
  systemPromptTotal: number;
  systemPromptMinusClaudeMd: number;
  claudeMd: number;
  toolSchemas: number;
  userMessages: number;
  assistantText: number;
  thinking: number;
  toolResults: number;
  total: number;
}

interface ToolGroup {
  name: string;
  tokens: number;
  callCount: number;
}

interface ResultRow {
  toolName: string;
  inputSummary: string;
  tokens: number;
  callId: string;
}

const BAR_WIDTH = 24;
const TOP_N_LARGEST = 10;

function computeBreakdown(props: ContextPickerProps): Breakdown {
  const sysFull = buildSystemPrompt({
    cwd: props.cwd,
    tools: props.tools,
    customSystemPrompt: props.customSystemPrompt,
    permissionMode: props.permissionMode,
    claudeMdFiles: props.claudeMdFiles,
  });
  const claudeMdSection =
    props.claudeMdFiles && props.claudeMdFiles.length > 0
      ? renderClaudeMdSection(props.claudeMdFiles)
      : '';
  const claudeMd = estimateTokens(claudeMdSection);
  const systemPromptTotal = estimateTokens(sysFull);
  const systemPromptMinusClaudeMd = Math.max(0, systemPromptTotal - claudeMd);
  const toolSchemas = estimateTokens(JSON.stringify(toOpenAITools(props.tools)));

  let userMessages = 0;
  let assistantText = 0;
  let thinking = 0;
  let toolResults = 0;

  for (const b of props.blocks) {
    switch (b.kind) {
      case 'user_prompt':
        userMessages += estimateTokens(b.text);
        break;
      case 'assistant_text':
        assistantText += estimateTokens(b.text);
        break;
      case 'thinking':
        thinking += estimateTokens(b.text);
        break;
      case 'tool_call':
        // Tool input JSON is part of the assistant turn; the result is the
        // bulk that flows back into context.
        assistantText += estimateTokens(JSON.stringify(b.input));
        if (b.result) toolResults += estimateTokens(b.result);
        break;
      // result/error/slash_output are TUI-only — never sent to the model.
    }
  }

  const total =
    systemPromptTotal +
    toolSchemas +
    userMessages +
    assistantText +
    thinking +
    toolResults;

  return {
    systemPromptTotal,
    systemPromptMinusClaudeMd,
    claudeMd,
    toolSchemas,
    userMessages,
    assistantText,
    thinking,
    toolResults,
    total,
  };
}

function groupByTool(blocks: UiBlock[]): ToolGroup[] {
  const map = new Map<string, ToolGroup>();
  for (const b of blocks) {
    if (b.kind !== 'tool_call' || !b.result) continue;
    const tokens = estimateTokens(b.result);
    const existing = map.get(b.name);
    if (existing) {
      existing.tokens += tokens;
      existing.callCount++;
    } else {
      map.set(b.name, { name: b.name, tokens, callCount: 1 });
    }
  }
  return [...map.values()].sort((a, b) => b.tokens - a.tokens);
}

function largestResults(blocks: UiBlock[]): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const b of blocks) {
    if (b.kind !== 'tool_call' || !b.result) continue;
    rows.push({
      toolName: b.name,
      inputSummary: summarizeInput(b.input),
      tokens: estimateTokens(b.result),
      callId: b.id,
    });
  }
  return rows.sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N_LARGEST);
}

function summarizeInput(input: Record<string, unknown>): string {
  const path = input['file_path'] ?? input['path'] ?? input['pattern'];
  if (typeof path === 'string') return path;
  const cmd = input['command'];
  if (typeof cmd === 'string') return cmd;
  const q = input['query'];
  if (typeof q === 'string') return q;
  return JSON.stringify(input).slice(0, 60);
}

export function ContextPicker(props: ContextPickerProps) {
  const [view, setView] = useState<View>({ kind: 'overview' });
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const breakdown = useMemo(() => computeBreakdown(props), [props, view]);
  const toolGroups = useMemo(() => groupByTool(props.blocks), [props.blocks, view]);
  const largest = useMemo(() => largestResults(props.blocks), [props.blocks, view]);

  if (view.kind === 'overview') {
    return (
      <OverviewView
        breakdown={breakdown}
        contextWindow={props.contextWindow}
        tokensUsed={props.tokensUsed}
        onPerTool={() => setView({ kind: 'per_tool', idx: 0 })}
        onLargest={() => setView({ kind: 'largest', idx: 0 })}
        onRefresh={() => refresh()}
        onCompact={async () => {
          props.onCancel();
          await props.onCompact();
        }}
        onCancel={props.onCancel}
        toolGroupCount={toolGroups.length}
      />
    );
  }
  if (view.kind === 'per_tool') {
    return (
      <PerToolView
        groups={toolGroups}
        selectedIdx={view.idx}
        contextWindow={props.contextWindow}
        breakdownTotal={breakdown.total}
        onMove={(idx) => setView({ kind: 'per_tool', idx })}
        onPick={() => setView({ kind: 'largest', idx: 0 })}
        onBack={() => setView({ kind: 'overview' })}
      />
    );
  }
  return (
    <LargestView
      rows={largest}
      selectedIdx={view.idx}
      onMove={(idx) => setView({ kind: 'largest', idx })}
      onBack={() => setView({ kind: 'per_tool', idx: 0 })}
    />
  );
}

function OverviewView({
  breakdown,
  contextWindow,
  tokensUsed,
  onPerTool,
  onLargest,
  onRefresh,
  onCompact,
  onCancel,
  toolGroupCount,
}: {
  breakdown: Breakdown;
  contextWindow: number;
  tokensUsed: number;
  onPerTool: () => void;
  onLargest: () => void;
  onRefresh: () => void;
  onCompact: () => void | Promise<void>;
  onCancel: () => void;
  toolGroupCount: number;
}) {
  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (input === 't') {
      if (toolGroupCount > 0) onPerTool();
      return;
    }
    if (input === 'l') {
      onLargest();
      return;
    }
    if (input === 'r') {
      onRefresh();
      return;
    }
    if (input === 'c') {
      void onCompact();
    }
  });

  // Headline matches the statusline: server-snapped prompt size, plus local
  // BPE delta for blocks that haven't reached the server yet.
  const stats = tokenStats(tokensUsed, contextWindow);
  const filled = Math.round((stats.percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const barColor =
    stats.percent >= 90 ? 'red' : stats.percent >= 70 ? 'yellow' : 'green';

  const rows: { label: string; tokens: number }[] = [
    { label: 'System prompt', tokens: breakdown.systemPromptMinusClaudeMd },
    { label: 'CLAUDE.md', tokens: breakdown.claudeMd },
    { label: 'Tool schemas', tokens: breakdown.toolSchemas },
    { label: 'User messages', tokens: breakdown.userMessages },
    { label: 'Assistant text', tokens: breakdown.assistantText },
    { label: 'Thinking', tokens: breakdown.thinking },
    { label: 'Tool results', tokens: breakdown.toolResults },
  ];

  const labelWidth = Math.max(...rows.map((r) => r.label.length));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Context Usage
        </Text>
      </Box>
      <Box>
        <Text>
          <Text color={barColor}>{'█'.repeat(filled)}</Text>
          <Text color="gray">{'░'.repeat(empty)}</Text>
          <Text>  </Text>
          <Text color={barColor} bold>
            {stats.percent}%
          </Text>
          <Text color="gray">
            {'  '}
            {formatTokenCount(tokensUsed)} / {formatTokenCount(contextWindow)}
          </Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        {rows.map((r) => {
          const pct = contextWindow > 0 ? (r.tokens / contextWindow) * 100 : 0;
          const miniFilled = Math.max(0, Math.min(10, Math.round((pct / 100) * 10)));
          const miniEmpty = 10 - miniFilled;
          return (
            <Box key={r.label}>
              <Text>
                <Text>  {r.label.padEnd(labelWidth)}  </Text>
                <Text color="gray">{formatTokenCount(r.tokens).padStart(6)}  </Text>
                <Text color="green">{'▓'.repeat(miniFilled)}</Text>
                <Text color="gray">{'░'.repeat(miniEmpty)}</Text>
                <Text color="gray">  {pct.toFixed(0).padStart(2)}%</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          t per-tool · l largest · c compact · r refresh · esc close
        </Text>
      </Box>
    </Box>
  );
}

function PerToolView({
  groups,
  selectedIdx,
  contextWindow,
  breakdownTotal,
  onMove,
  onPick,
  onBack,
}: {
  groups: ToolGroup[];
  selectedIdx: number;
  contextWindow: number;
  breakdownTotal: number;
  onMove: (idx: number) => void;
  onPick: () => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (groups.length === 0) return;
    if (key.upArrow) {
      onMove(Math.max(0, selectedIdx - 1));
      return;
    }
    if (key.downArrow) {
      onMove(Math.min(groups.length - 1, selectedIdx + 1));
      return;
    }
    if (key.return) {
      onPick();
    }
  });

  if (groups.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Tokens per tool
        </Text>
        <Text color="gray">No tool calls in this session yet.</Text>
        <Box marginTop={1}>
          <Text color="gray">esc to back</Text>
        </Box>
      </Box>
    );
  }

  const nameWidth = Math.max(...groups.map((g) => g.name.length));
  const denom = Math.max(breakdownTotal, contextWindow);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Tokens per tool ({selectedIdx + 1} of {groups.length})
        </Text>
      </Box>
      {groups.map((g, i) => {
        const selected = i === selectedIdx;
        const pct = denom > 0 ? (g.tokens / denom) * 100 : 0;
        const filled = Math.max(0, Math.min(10, Math.round((pct / 100) * 10)));
        const empty = 10 - filled;
        return (
          <Box key={g.name}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {g.name.padEnd(nameWidth)}
              </Text>
              <Text color="gray">  {formatTokenCount(g.tokens).padStart(6)}  </Text>
              <Text color="green">{'▓'.repeat(filled)}</Text>
              <Text color="gray">{'░'.repeat(empty)}</Text>
              <Text color="gray">  {g.callCount} call{g.callCount === 1 ? '' : 's'}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · enter for largest · esc back</Text>
      </Box>
    </Box>
  );
}

function LargestView({
  rows,
  selectedIdx,
  onMove,
  onBack,
}: {
  rows: ResultRow[];
  selectedIdx: number;
  onMove: (idx: number) => void;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (rows.length === 0) return;
    if (key.upArrow) {
      onMove(Math.max(0, selectedIdx - 1));
      return;
    }
    if (key.downArrow) {
      onMove(Math.min(rows.length - 1, selectedIdx + 1));
    }
  });

  if (rows.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          Largest tool results
        </Text>
        <Text color="gray">No tool results in this session yet.</Text>
        <Box marginTop={1}>
          <Text color="gray">esc to back</Text>
        </Box>
      </Box>
    );
  }

  const nameWidth = Math.max(...rows.map((r) => r.toolName.length));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Largest tool results ({selectedIdx + 1} of {rows.length})
        </Text>
      </Box>
      {rows.map((r, i) => {
        const selected = i === selectedIdx;
        const idx = (i + 1).toString().padStart(2, ' ');
        return (
          <Box key={r.callId}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {idx}. {r.toolName.padEnd(nameWidth)}
              </Text>
              <Text color="gray">  {formatTokenCount(r.tokens).padStart(6)}  </Text>
              <Text color="gray">{truncate(r.inputSummary, 50)}</Text>
            </Text>
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · esc back</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
