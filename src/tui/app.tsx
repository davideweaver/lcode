import { Box, Static, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import type { LcodeConfig } from '../config.js';
import { probeLlm, type HealthResult } from '../health.js';
import { query } from '../core/query.js';
import type { SDKMessage } from '../core/messages.js';
import { BlockList } from './blocks.js';
import { Divider } from './divider.js';
import { getGitBranch } from './git.js';
import { messagesToBlocks } from './replay.js';
import { ResumePicker } from './resume-picker.js';
import { ModelPicker } from './model-picker.js';
import {
  getSlashQuery,
  isSlashPopupOpen,
  matchCommands,
  maybeRunSlashCommand,
  SlashPopup,
} from './slash.js';
import { StatusLine } from './statusline.js';
import { sdkMessageTokens } from './tokens.js';
import type { UiBlock } from './types.js';
import { loadSessionMessages } from '../core/session.js';
import type { SessionSummary } from '../core/sessions.js';
import { loadClaudeMdFiles, type ClaudeMdFile } from '../prompts/claudemd.js';
import { loadMcpServers } from '../mcp/config.js';
import { McpManager } from '../mcp/manager.js';

type HeaderItem = { kind: 'health'; health: HealthResult };

type TurnStatus =
  | { kind: 'idle' }
  | { kind: 'working'; startedAt: number }
  | { kind: 'done'; durationMs: number };

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}m ${sec}s`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `${hr}h ${remMin}m`;
}

const SYSTEM_PROMPT_TOKEN_ESTIMATE = 700;

interface AppProps {
  config: LcodeConfig;
  resume?: string;
}

export function App({ config, resume }: AppProps) {
  const { exit } = useApp();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [input, setInput] = useState('');
  const [turnStatus, setTurnStatus] = useState<TurnStatus>({ kind: 'idle' });
  const [sessionId, setSessionId] = useState<string | undefined>(resume);
  const [tokensUsed, setTokensUsed] = useState(SYSTEM_PROMPT_TOKEN_ESTIMATE);
  const [branch, setBranch] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [inputKey, setInputKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [currentModel, setCurrentModel] = useState(config.model);
  const [claudeMdFiles, setClaudeMdFiles] = useState<ClaudeMdFile[] | undefined>(undefined);
  const [showThinking, setShowThinking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // One MCP manager per chat session. Created lazily on first render so we
  // can pass in discovered configs; cleaned up on unmount.
  const mcpManagerRef = useRef<McpManager | null>(null);
  if (mcpManagerRef.current === null) {
    mcpManagerRef.current = new McpManager([]);
  }
  // ink-text-input doesn't filter ctrl+letter combos, so the literal letter
  // would land in the input value. We set this flag in our useInput handler
  // before TextInput's handler runs; the next onChange consumes it.
  const swallowInputChange = useRef(false);

  /**
   * Replace the input value externally and remount TextInput so the cursor
   * lands at the end of the new value. Used by Tab autocomplete and ESC-ESC
   * clear. ink-text-input's controlled mode doesn't reposition the cursor
   * when the parent grows the value, so a key bump is the cleanest fix
   * without forking the dep.
   */
  const replaceInput = useCallback((next: string) => {
    setInput(next);
    setInputKey((k) => k + 1);
  }, []);

  const handleInputChange = useCallback((next: string) => {
    if (swallowInputChange.current) {
      swallowInputChange.current = false;
      return;
    }
    setInput(next);
  }, []);

  const onPickerSelect = useCallback(
    async (summary: SessionSummary) => {
      setPickerOpen(false);
      try {
        const messages = await loadSessionMessages(summary.sessionId, summary.cwd);
        const replayed = messagesToBlocks(messages);
        const replayedTokens = messages.reduce((sum, m) => sum + sdkMessageTokens(m), 0);
        setBlocks(replayed);
        setSessionId(summary.sessionId);
        setTokensUsed(SYSTEM_PROMPT_TOKEN_ESTIMATE + replayedTokens);
        setTurnStatus({ kind: 'idle' });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBlocks((b) => [
          ...b,
          { kind: 'error', text: `Failed to resume session: ${msg}` },
        ]);
      }
    },
    [],
  );
  const busy = turnStatus.kind === 'working';
  const slashOpen = !busy && isSlashPopupOpen(input);
  const slashMatches = slashOpen ? matchCommands(getSlashQuery(input)) : [];

  // Reset highlight to first match whenever the slash query changes.
  useEffect(() => {
    setSlashIdx(0);
  }, [input]);

  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [busy]);

  const cwd = useMemo(() => process.cwd(), []);
  const folderLabel = useMemo(() => basename(cwd), [cwd]);

  useEffect(() => {
    const ctl = new AbortController();
    probeLlm(config, ctl.signal).then(setHealth);
    return () => ctl.abort();
  }, [config]);

  useEffect(() => {
    getGitBranch(cwd).then(setBranch);
  }, [cwd]);

  // Load CLAUDE.md (user + project + ancestors) once per session and reuse
  // across every query() call. Mid-session edits to CLAUDE.md won't take
  // effect until the user starts a new session.
  useEffect(() => {
    loadClaudeMdFiles(cwd).then(setClaudeMdFiles);
  }, [cwd]);

  // Load MCP server configs and connect once per chat session. We replace
  // the manager here (rather than mutating the empty one created at first
  // render) so the configs are baked in. Cleanup on unmount closes all
  // transport connections (stdio subprocesses, SSE streams, etc.).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const configs = await loadMcpServers(cwd);
      if (cancelled) return;
      const manager = new McpManager(configs);
      mcpManagerRef.current = manager;
      await manager.start();
    })();
    return () => {
      cancelled = true;
      const m = mcpManagerRef.current;
      if (m) void m.close();
    };
  }, [cwd]);

  const lastEscRef = useRef<number>(0);
  useInput(
    (inputChar, key) => {
      if (key.ctrl && inputChar === 'c') {
        abortRef.current?.abort();
        exit();
        return;
      }
      if (key.ctrl && inputChar === 'o') {
        swallowInputChange.current = true;
        // Clear at end of tick so a future stray keystroke isn't dropped
        // (e.g. on terminals that don't emit a literal "o" for ctrl+o).
        queueMicrotask(() => {
          swallowInputChange.current = false;
        });
        setShowThinking((s) => !s);
        return;
      }
      if (key.escape) {
        if (busy) {
          abortRef.current?.abort();
          lastEscRef.current = 0;
          return;
        }
        const now = Date.now();
        if (now - lastEscRef.current < 500) {
          replaceInput('');
          lastEscRef.current = 0;
        } else {
          lastEscRef.current = now;
        }
        return;
      }
      if (slashOpen && slashMatches.length > 0) {
        if (key.upArrow) {
          setSlashIdx((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSlashIdx((i) => Math.min(slashMatches.length - 1, i + 1));
          return;
        }
        if (key.tab) {
          const selected = slashMatches[slashIdx] ?? slashMatches[0];
          if (selected) replaceInput('/' + selected.name + ' ');
          return;
        }
      }
    },
    { isActive: process.stdin.isTTY === true },
  );

  const onSubmit = useCallback(
    async (prompt: string) => {
      let trimmed = prompt.trim();
      if (!trimmed || busy) return;
      setInput('');

      // If the slash popup is open with at least one match, Enter runs the
      // highlighted command — even if the user only typed `/` or a partial
      // prefix that doesn't match a command name exactly.
      if (isSlashPopupOpen(trimmed)) {
        const matches = matchCommands(getSlashQuery(trimmed));
        const selected = matches[slashIdx] ?? matches[0];
        if (selected) trimmed = '/' + selected.name;
      }

      if (trimmed.startsWith('/')) {
        await maybeRunSlashCommand(trimmed, {
          cwd,
          config,
          sessionId,
          currentModel,
          setCurrentModel,
          addBlock: (block) => setBlocks((b) => [...b, block]),
          clearSession: () => {
            setBlocks([]);
            setSessionId(undefined);
            setTokensUsed(SYSTEM_PROMPT_TOKEN_ESTIMATE);
            setTurnStatus({ kind: 'idle' });
          },
          openResumePicker: () => setPickerOpen(true),
          openModelPicker: () => setModelPickerOpen(true),
          mcpManager: mcpManagerRef.current!,
          exit,
        });
        return;
      }

      const userBlock: UiBlock = { kind: 'user_prompt', text: trimmed };
      setBlocks((b) => [...b, userBlock]);
      const startedAt = Date.now();
      setTurnStatus({ kind: 'working', startedAt });
      // Token accounting for the user prompt happens via drainStream when
      // the loop yields the SDKUserMessage for it.

      const ctl = new AbortController();
      abortRef.current = ctl;
      try {
        const stream = query({
          prompt: trimmed,
          cwd,
          model: currentModel,
          abortController: ctl,
          resume: sessionId,
          includePartialMessages: true,
          config,
          claudeMdFiles,
          mcpManager: mcpManagerRef.current!,
        });
        await drainStream(stream, setBlocks, setSessionId, setTokensUsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBlocks((b) => [...b, { kind: 'error', text: msg }]);
      } finally {
        setTurnStatus({ kind: 'done', durationMs: Date.now() - startedAt });
        abortRef.current = null;
      }
    },
    [busy, config, cwd, sessionId, slashIdx, claudeMdFiles, currentModel, exit],
  );

  const headerItems = useMemo<HeaderItem[]>(() => {
    return health ? [{ kind: 'health', health }] : [];
  }, [health]);

  return (
    <Box flexDirection="column">
      <Static items={headerItems}>
        {(item, i) => (
          <Box key={i}>
            <HealthLine health={item.health} configuredModel={config.model} />
          </Box>
        )}
      </Static>

      <BlockList blocks={blocks} showThinking={showThinking} />

      {turnStatus.kind !== 'idle' && (
        <Box marginTop={1}>
          {turnStatus.kind === 'working' ? (
            <Text color="yellow">
              <Text>{tick % 2 === 0 ? '*' : ' '}</Text>
              <Text>
                {' '}Working... ({formatDuration(Date.now() - turnStatus.startedAt)})
              </Text>
            </Text>
          ) : (
            <Text dimColor>* Done in {formatDuration(turnStatus.durationMs)}</Text>
          )}
        </Box>
      )}

      <Box marginTop={turnStatus.kind === 'idle' ? 1 : 0}>
        <Divider />
      </Box>

      {pickerOpen ? (
        <ResumePicker
          cwd={cwd}
          onSelect={onPickerSelect}
          onCancel={() => setPickerOpen(false)}
        />
      ) : modelPickerOpen ? (
        <ModelPicker
          config={config}
          currentModel={currentModel}
          onSelect={(m) => {
            setCurrentModel(m);
            setModelPickerOpen(false);
            setBlocks((b) => [
              ...b,
              { kind: 'slash_output', text: `* model set to ${m}` },
            ]);
          }}
          onCancel={() => setModelPickerOpen(false)}
        />
      ) : (
        <>
          <Box>
            {process.stdin.isTTY ? (
              <Box>
                <Text color={busy ? 'gray' : 'cyan'}>› </Text>
                <TextInput
                  key={inputKey}
                  value={input}
                  onChange={handleInputChange}
                  onSubmit={onSubmit}
                  focus={!busy}
                />
              </Box>
            ) : (
              <Text dimColor>(non-interactive: stdin is not a TTY)</Text>
            )}
          </Box>

          <Divider />

          {slashOpen ? (
            <SlashPopup input={input} selectedIdx={slashIdx} />
          ) : (
            <StatusLine
              folderLabel={folderLabel}
              branch={branch}
              tokensUsed={tokensUsed}
              contextWindow={config.contextWindow}
              sessionId={sessionId}
              showThinking={showThinking}
            />
          )}
        </>
      )}
    </Box>
  );
}

function BlockListItem({
  block,
  showThinking,
}: {
  block: UiBlock;
  showThinking: boolean;
}) {
  return <BlockList blocks={[block]} showThinking={showThinking} />;
}

async function drainStream(
  stream: AsyncGenerator<SDKMessage>,
  setBlocks: React.Dispatch<React.SetStateAction<UiBlock[]>>,
  setSessionId: (id: string) => void,
  setTokensUsed: React.Dispatch<React.SetStateAction<number>>,
) {
  for await (const msg of stream) {
    if (msg.type === 'assistant' || msg.type === 'user') {
      setTokensUsed((t) => t + sdkMessageTokens(msg));
    }
    switch (msg.type) {
      case 'system':
        setSessionId(msg.session_id);
        break;
      case 'partial_assistant': {
        const ev = msg.event;
        if (ev.kind === 'text_delta') {
          setBlocks((b) => appendTextDelta(b, ev.text));
        } else if (ev.kind === 'thinking_start') {
          setBlocks((b) => [
            ...finalizeStreamingText(b),
            {
              kind: 'thinking',
              text: '',
              streaming: true,
              startedAt: Date.now(),
            },
          ]);
        } else if (ev.kind === 'thinking_delta') {
          setBlocks((b) => appendThinkingDelta(b, ev.text));
        } else if (ev.kind === 'thinking_stop') {
          setBlocks((b) => finalizeStreamingThinking(b));
        } else if (ev.kind === 'tool_use_start') {
          setBlocks((b) => [
            ...finalizeStreamingText(b),
            ...[],
            {
              kind: 'tool_call',
              id: ev.id,
              name: ev.name,
              input: {},
              status: 'pending',
            },
          ]);
        }
        break;
      }
      case 'assistant':
        // Reconcile final text + finalize any streaming text block
        setBlocks((b) => finalizeStreamingText(b));
        // Update tool_call inputs from final content
        setBlocks((b) => reconcileToolInputs(b, msg));
        break;
      case 'user': {
        // Tool results — apply to matching tool_call blocks
        setBlocks((b) => applyToolResults(b, msg));
        break;
      }
      case 'result':
        setBlocks((b) => [
          ...b,
          { kind: 'result', subtype: msg.subtype, text: msg.error ?? msg.result },
        ]);
        break;
    }
  }
}

function appendTextDelta(blocks: UiBlock[], text: string): UiBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'assistant_text' && last.streaming) {
    return [
      ...blocks.slice(0, -1),
      { ...last, text: last.text + text },
    ];
  }
  return [...blocks, { kind: 'assistant_text', text, streaming: true }];
}

function finalizeStreamingText(blocks: UiBlock[]): UiBlock[] {
  return blocks.map((b) =>
    b.kind === 'assistant_text' && b.streaming ? { ...b, streaming: false } : b,
  );
}

function appendThinkingDelta(blocks: UiBlock[], text: string): UiBlock[] {
  const last = blocks[blocks.length - 1];
  if (last && last.kind === 'thinking' && last.streaming) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + text }];
  }
  // No active thinking block (shouldn't normally happen, but be defensive).
  return [
    ...blocks,
    { kind: 'thinking', text, streaming: true, startedAt: Date.now() },
  ];
}

function finalizeStreamingThinking(blocks: UiBlock[]): UiBlock[] {
  return blocks.map((b) => {
    if (b.kind !== 'thinking' || !b.streaming) return b;
    return { ...b, streaming: false, durationMs: Date.now() - b.startedAt };
  });
}

function reconcileToolInputs(
  blocks: UiBlock[],
  msg: Extract<SDKMessage, { type: 'assistant' }>,
): UiBlock[] {
  const inputsById = new Map<string, Record<string, unknown>>();
  for (const block of msg.message.content) {
    if (block.type === 'tool_use') inputsById.set(block.id, block.input);
  }
  return blocks.map((b) => {
    if (b.kind !== 'tool_call') return b;
    const input = inputsById.get(b.id);
    if (!input) return b;
    return { ...b, input };
  });
}

function applyToolResults(
  blocks: UiBlock[],
  msg: Extract<SDKMessage, { type: 'user' }>,
): UiBlock[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const block of msg.message.content) {
    if (block.type === 'tool_result') {
      const content = typeof block.content === 'string'
        ? block.content
        : block.content.map((c) => c.text).join('');
      results.set(block.tool_use_id, { content, isError: block.is_error ?? false });
    }
  }
  return blocks.map((b) => {
    if (b.kind !== 'tool_call') return b;
    const r = results.get(b.id);
    if (!r) return b;
    return { ...b, status: r.isError ? 'error' : 'done', result: r.content };
  });
}

function HealthLine({
  health,
  configuredModel,
}: {
  health: HealthResult | null;
  configuredModel: string;
}) {
  if (health === null) return <Text color="yellow">probing…</Text>;
  if (!health.ok) return <Text color="red">✗ unreachable: {health.error ?? 'unknown'}</Text>;
  if (!health.modelMatchesConfig) {
    return (
      <Text color="yellow">
        ⚠ reachable; "{configuredModel}" not loaded
        {health.modelLoaded ? ` (loaded: ${health.modelLoaded})` : ''}
      </Text>
    );
  }
  return <Text color="green">✓ ready: {configuredModel}</Text>;
}
