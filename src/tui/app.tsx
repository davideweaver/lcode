import { Box, Static, Text, useApp, useInput } from 'ink';
import { MultilineInput, PASTE_PLACEHOLDER_RE } from './multiline-input.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { basename } from 'node:path';
import type { LcodeConfig } from '../config.js';
import { probeLlm, type HealthResult } from '../health.js';
import { query } from '../core/query.js';
import type { ContentBlock, ImageMediaType, SDKMessage } from '../core/messages.js';
import { imageBlockFromPath, textBlock } from '../core/messages.js';
import { allocateNext as allocateImage } from '../core/image-cache.js';
import { tryReadClipboardImage } from '../core/clipboard.js';
import { Banner } from './banner.js';
import { BlockList } from './blocks.js';
import { Divider } from './divider.js';
import { getGitBranch } from './git.js';
import { extractUserPrompts, messagesToBlocks } from './replay.js';
import { ResumePicker } from './resume-picker.js';
import { ModelPicker } from './model-picker.js';
import { McpPicker } from './mcp-picker.js';
import { ContextPicker } from './context-picker.js';
import { BUILTIN_TOOLS } from '../tools/builtin/index.js';
import { manualCompact } from '../core/compactor.js';
import {
  getSlashQuery,
  isSlashPopupOpen,
  matchCommands,
  maybeRunSlashCommand,
  SlashPopup,
} from './slash.js';
import { StatusLine } from './statusline.js';
import { estimateTokens, sdkMessageTokens } from './tokens.js';
import { buildSystemPrompt } from '../prompts/system.js';
import { toOpenAITools } from '../core/llm.js';
import type { UiBlock } from './types.js';
import { loadSessionMessages } from '../core/session.js';
import type { SessionSummary } from '../core/sessions.js';
import { loadClaudeMdFiles, type ClaudeMdFile } from '../prompts/claudemd.js';
import { defaultAgentFiles, loadAgentFiles, type AgentFiles } from '../prompts/agents.js';
import { loadMcpServers } from '../mcp/config.js';
import { loadDisabledServers } from '../mcp/disabled.js';
import { McpManager } from '../mcp/manager.js';
import { findProjectRoot, loadSkills } from '../skills/loader.js';
import { loadEnabled, setEnabled } from '../skills/enabled.js';
import type { Skill } from '../skills/types.js';
import { SkillsPicker } from './skills-picker.js';
import { debugLog, debugLogPath, isDebugEnabled } from '../core/debug-log.js';

type HeaderItem = { kind: 'banner'; health: HealthResult };

type TurnStatus =
  | { kind: 'idle' }
  | { kind: 'working'; startedAt: number }
  | { kind: 'done'; durationMs: number }
  | { kind: 'interrupted'; durationMs: number };

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

interface AppProps {
  config: LcodeConfig;
  resume?: string;
  /**
   * When true, skip reading ~/.lcode/settings.json and use the built-in
   * default persona/human/capabilities/instructions. Set by the
   * `--no-agent-files` CLI flag.
   */
  skipAgentFiles?: boolean;
  /**
   * When true, skip MCP server discovery and connection entirely. The
   * session runs with builtin tools only. Set by `--no-mcp`.
   */
  skipMcp?: boolean;
  /**
   * Replace the entire built-in system prompt with this string for every
   * turn in this session. Set by `--sys-prompt`.
   */
  overrideSystemPrompt?: string;
  /**
   * Forwarded to the LLM as `chat_template_kwargs.enable_thinking`. Default
   * true. Set false via `--no-thinking` for latency-sensitive runs.
   */
  enableThinking?: boolean;
  /**
   * Called whenever the session id changes (incl. when the loop's first
   * `system: init` arrives for a brand-new chat). The CLI uses this to
   * show a "Resume this session with: ..." hint after the TUI exits.
   */
  onSessionChange?: (sessionId: string | undefined) => void;
}

export function App({ config, resume, skipAgentFiles, skipMcp, overrideSystemPrompt, enableThinking, onSessionChange }: AppProps) {
  const { exit } = useApp();
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [blocks, setBlocks] = useState<UiBlock[]>([]);
  const [input, setInput] = useState('');
  const [turnStatus, setTurnStatus] = useState<TurnStatus>({ kind: 'idle' });
  const [sessionId, setSessionId] = useState<string | undefined>(resume);
  const [tokensUsed, setTokensUsed] = useState(0);
  // The local BPE estimate is a proxy until the first assistant turn re-snaps
  // it to the server's `usage.input_tokens`. Until then the statusline shows
  // an empty bar and "—%" so we don't lie about the actual prompt size.
  const [tokensUsedVerified, setTokensUsedVerified] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [inputKey, setInputKey] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [mcpPickerOpen, setMcpPickerOpen] = useState(false);
  const [contextPickerOpen, setContextPickerOpen] = useState(false);
  const [skillsPickerOpen, setSkillsPickerOpen] = useState(false);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [enabledSkillNames, setEnabledSkillNames] = useState<Set<string>>(new Set());
  const projectRootRef = useRef<string | null>(null);
  const [currentModel, setCurrentModel] = useState(config.model);
  const [claudeMdFiles, setClaudeMdFiles] = useState<ClaudeMdFile[] | undefined>(undefined);
  const [agentFiles, setAgentFiles] = useState<AgentFiles | undefined>(undefined);
  const [mcpToolsReady, setMcpToolsReady] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  // Set by cancelTurn() so the finally block in onSubmit can distinguish
  // user-initiated cancellation from natural completion or hard errors.
  const cancelledRef = useRef(false);
  // Most recently submitted prompt — restored to the input on cancel so the
  // user can edit and resubmit instead of retyping.
  const lastPromptRef = useRef('');
  // In-memory prompt history for up/down recall. Submitted prompts are
  // appended; consecutive duplicates are skipped. historyIdx === null means
  // the user is editing a fresh draft; otherwise it points into history.
  // draftRef holds whatever was in the input when history nav started, so
  // pressing past the newest entry restores it.
  const historyRef = useRef<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const draftRef = useRef('');
  // One MCP manager per chat session. Created lazily on first render so we
  // can pass in discovered configs; cleaned up on unmount.
  const mcpManagerRef = useRef<McpManager | null>(null);
  if (mcpManagerRef.current === null) {
    mcpManagerRef.current = new McpManager([]);
  }
  // MultilineInput drops ctrl/meta combos itself, so the parent no longer
  // needs to filter them out of onChange. Kept the inputKey bump approach so
  // history nav / tab-complete reset the cursor cleanly via remount.
  /**
   * Replace the input value externally and remount the input so the cursor
   * lands at the end of the new value. Used by Tab autocomplete and ESC-ESC
   * clear.
   */
  const replaceInput = useCallback((next: string) => {
    setInput(next);
    setInputKey((k) => k + 1);
  }, []);

  const handleInputChange = useCallback((next: string) => {
    setInput(next);
  }, []);

  // Set by MultilineInput when it consumes an Alt+Enter / Shift+Enter
  // sequence at the byte level. Resets on the next microtask. While set, the
  // useInput handler below bails so the leftover events Ink still dispatches
  // for that data chunk (ESC, stray text) don't trigger our shortcuts.
  const inputConsumedRef = useRef(false);

  // Pasted images bound to placeholders in the current input buffer.
  // Keyed by the global image number; values point at the cached PNG on
  // disk under ~/.lcode/image-cache/. The map is cleared on submit and on
  // /clear, so placeholders only resolve within the buffer that captured
  // them — typing `[Image #29]` literally without pasting attaches nothing.
  const attachmentsRef = useRef(
    new Map<number, { path: string; mediaType: ImageMediaType }>(),
  );

  // Pasted multi-line text bound to `[Pasted text #N +M lines]` tokens in
  // the current input buffer. Like attachmentsRef, this map and its
  // counter reset on submit / /clear so numbers stay small and tokens
  // only resolve within the buffer that captured them.
  const pastedTextsRef = useRef(new Map<number, string>());
  const pasteCounterRef = useRef(0);

  const sessionIdRef = useRef<string | undefined>(sessionId);
  sessionIdRef.current = sessionId;

  // Called by MultilineInput on Ctrl+V or bracketed-paste-start. Reads the
  // OS clipboard for image data; if found, caches it and registers the
  // placeholder→file mapping so onSubmit can build the multimodal message.
  const onPasteImage = useCallback(async (): Promise<{ n: number } | null> => {
    try {
      const { n, path, mediaType } = await allocateImage(
        sessionIdRef.current ?? 'unsaved',
      );
      const result = await tryReadClipboardImage(path);
      if (!result) return null;
      attachmentsRef.current.set(n, { path, mediaType: result.mediaType ?? mediaType });
      return { n };
    } catch {
      return null;
    }
  }, []);

  // Called by MultilineInput when a long multi-line paste arrives. Assigns
  // the next placeholder number for this buffer, stashes the body, and
  // returns the number so the input can render `[Pasted text #N +M lines]`.
  const onPasteText = useCallback((body: string): { n: number } | null => {
    pasteCounterRef.current += 1;
    const n = pasteCounterRef.current;
    pastedTextsRef.current.set(n, body);
    return { n };
  }, []);

  // Shared logic between the in-TUI /resume picker and the CLI --resume
  // flag: load the session's JSONL, replay blocks, restore token count, and
  // seed prompt-history navigation.
  const applyResumedSession = useCallback(
    async (resumeId: string, sessionCwd: string) => {
      const messages = await loadSessionMessages(resumeId, sessionCwd);
      const replayed = messagesToBlocks(messages);
      setBlocks(replayed);
      setSessionId(resumeId);
      setTokensUsed(restoreTokensUsed(messages));
      setTokensUsedVerified(false);
      setTurnStatus({ kind: 'idle' });
      historyRef.current = extractUserPrompts(messages);
      setHistoryIdx(null);
      draftRef.current = '';
    },
    [],
  );

  const onPickerSelect = useCallback(
    async (summary: SessionSummary) => {
      setPickerOpen(false);
      try {
        await applyResumedSession(summary.sessionId, summary.cwd);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setBlocks((b) => [
          ...b,
          { kind: 'error', text: `Failed to resume session: ${msg}` },
        ]);
      }
    },
    [applyResumedSession],
  );
  const busy = turnStatus.kind === 'working';
  const slashOpen = !busy && isSlashPopupOpen(input);
  const slashMatches = slashOpen ? matchCommands(getSlashQuery(input), skills, enabledSkillNames) : [];

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
    probeLlm(config, ctl.signal, currentModel).then((h) => {
      setHealth(h);
      // Probe done = the model is "ready" from the user's POV. Even before
      // the first server snap we have a usable local BPE estimate, so let
      // the statusline come out of "—%" mode now. The first assistant turn
      // will subsequently re-snap to ground truth.
      setTokensUsedVerified(true);
    });
    return () => ctl.abort();
  }, [config, currentModel]);

  // Opt the terminal into xterm modifyOtherKeys mode 1 so Shift+Enter sends
  // a distinct sequence (`\x1b[27;2;13~`) instead of being indistinguishable
  // from plain Enter (`\r`). MultilineInput detects that sequence and
  // inserts a newline. We use mode 1 specifically — it leaves unmodified
  // keys as legacy bytes, which keeps Ink's keypress parser working for
  // Enter/Backspace/arrows. Also push the kitty progressive-enhancement
  // flag (CSI > 1 u → \x1b[>1u disambiguate); supporting terminals often
  // accept both, and modeling after Codex's `keyboard_modes.rs`.
  // Sequences are silently ignored on terminals that don't implement them
  // (e.g. macOS Terminal.app); those users can still use Ctrl+J or `\<Enter>`.
  useEffect(() => {
    if (!process.stdout.isTTY) return;
    process.stdout.write('\x1b[>4;1m');
    // Bracketed paste mode (DECSET 2004): the terminal wraps pasted content
    // in `\x1b[200~...\x1b[201~`. MultilineInput uses the start sequence as
    // a Cmd+V signal to probe the system clipboard for image data.
    process.stdout.write('\x1b[?2004h');
    const cleanup = () => {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[>4;0m');
        process.stdout.write('\x1b[?2004l');
      }
    };
    process.on('exit', cleanup);
    return () => {
      cleanup();
      process.off('exit', cleanup);
    };
  }, []);

  // Prefer the live `n_ctx` from `/props` over the static config so the
  // statusline reflects the model's actual context size after the user
  // restarts llama.cpp with a different ctx.
  const effectiveContextWindow = health?.contextWindow ?? config.contextWindow;

  const runCompactNow = useCallback(async () => {
    if (!sessionId) {
      setBlocks((b) => [
        ...b,
        { kind: 'slash_output', text: '* nothing to compact yet — send a prompt first.' },
      ]);
      return;
    }
    setBlocks((b) => [
      ...b,
      { kind: 'slash_output', text: '* compacting…' },
    ]);
    try {
      const ctl = new AbortController();
      const result = await manualCompact({
        sessionId,
        cwd,
        baseUrl: config.llmUrl,
        apiKey: config.apiKey,
        model: currentModel,
        contextWindow: effectiveContextWindow,
        threshold: config.compactThreshold,
        signal: ctl.signal,
      });
      if (result.tier === 'noop') {
        setBlocks((b) => [
          ...b,
          { kind: 'slash_output', text: '* nothing to compact (history is too short or already compacted).' },
        ]);
        return;
      }
      const tier: 'tier1' | 'tier2' = result.tier;
      setTokensUsed((t) => Math.max(0, t - result.savedTokens));
      setBlocks((b) => [
        ...b,
        {
          kind: 'compaction',
          subtype: tier,
          savedTokens: result.savedTokens,
          summary: result.summary,
        },
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setBlocks((b) => [
        ...b,
        { kind: 'error', text: `compaction failed: ${msg}` },
      ]);
    }
  }, [sessionId, cwd, config, currentModel, effectiveContextWindow]);

  useEffect(() => {
    getGitBranch(cwd).then(setBranch);
  }, [cwd]);

  useEffect(() => {
    onSessionChange?.(sessionId);
  }, [sessionId, onSessionChange]);

  // When the CLI was launched with --resume <id>, replay the session on
  // mount so the user sees the prior conversation, the token meter is
  // accurate, and up-arrow recall works immediately. Mirrors what the
  // in-TUI /resume picker does.
  useEffect(() => {
    if (!resume) return;
    let cancelled = false;
    applyResumedSession(resume, cwd).catch((err) => {
      if (cancelled) return;
      const msg = err instanceof Error ? err.message : String(err);
      setBlocks((b) => [
        ...b,
        { kind: 'error', text: `Failed to resume session: ${msg}` },
      ]);
    });
    return () => {
      cancelled = true;
    };
  }, [resume, cwd, applyResumedSession]);

  // Load CLAUDE.md (user + project + ancestors) once per session and reuse
  // across every query() call. Mid-session edits to CLAUDE.md won't take
  // effect until the user starts a new session.
  useEffect(() => {
    loadClaudeMdFiles(cwd).then(setClaudeMdFiles);
  }, [cwd]);

  // Skills: discover at mount and load the per-project enabled set. The
  // onSubmit handler re-runs both before each query() so mid-session edits
  // to SKILL.md frontmatter and toggles via /skills both propagate to the
  // next user turn without needing a session restart.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const root = await findProjectRoot(cwd);
      if (cancelled) return;
      projectRootRef.current = root;
      const [discovered, enabled] = await Promise.all([
        loadSkills(cwd),
        loadEnabled(root),
      ]);
      if (cancelled) return;
      setSkills(discovered);
      setEnabledSkillNames(enabled);
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  // Load ~/.lcode agent files (PERSONA/HUMAN/CAPABILITIES/INSTRUCTIONS) once
  // per session. Done at startup so settings.json is auto-created on first
  // launch even if the user never submits a prompt. `--no-agent-files`
  // short-circuits to the built-in defaults and leaves settings.json alone.
  useEffect(() => {
    if (skipAgentFiles) {
      setAgentFiles(defaultAgentFiles());
      return;
    }
    loadAgentFiles().then(setAgentFiles);
  }, [skipAgentFiles]);

  // Load MCP server configs and connect once per chat session. We replace
  // the manager here (rather than mutating the empty one created at first
  // render) so the configs are baked in. Cleanup on unmount closes all
  // transport connections (stdio subprocesses, SSE streams, etc.).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (skipMcp) {
        const manager = new McpManager([]);
        mcpManagerRef.current = manager;
        if (!cancelled) setMcpToolsReady(true);
        return;
      }
      const [entries, disabled] = await Promise.all([
        loadMcpServers(cwd),
        loadDisabledServers(),
      ]);
      if (cancelled) return;
      const manager = new McpManager(entries, { disabled });
      mcpManagerRef.current = manager;
      await manager.start();
      if (!cancelled) setMcpToolsReady(true);
    })();
    return () => {
      cancelled = true;
      const m = mcpManagerRef.current;
      if (m) void m.close();
    };
  }, [cwd, skipMcp]);

  // Seed tokensUsed with a real baseline (system prompt + tool schemas) once
  // the async-loaded sources are ready. Replaces the legacy 700-token guess
  // so /context and the statusline match the breakdown before the first turn.
  // After the first server-reported usage arrives, tokensUsedVerified flips
  // true and this effect stops firing.
  useEffect(() => {
    if (tokensUsedVerified || blocks.length > 0) return;
    if (!agentFiles || !claudeMdFiles) return;
    const tools = [
      ...BUILTIN_TOOLS,
      ...(mcpManagerRef.current?.tools() ?? []),
    ];
    const sys = buildSystemPrompt({
      cwd,
      tools,
      claudeMdFiles,
      agentFiles,
    });
    const schemas = JSON.stringify(toOpenAITools(tools));
    setTokensUsed(estimateTokens(sys) + estimateTokens(schemas));
  }, [agentFiles, claudeMdFiles, cwd, blocks.length, tokensUsedVerified, mcpToolsReady]);

  const cancelTurn = useCallback(() => {
    cancelledRef.current = true;
    abortRef.current?.abort();
  }, []);

  // Mirror `busy` and `cancelTurn` into refs so the long-lived stdin
  // safety-net listener (installed once on mount) always reads the current
  // values without needing to be re-registered on every state change.
  const busyRef = useRef(false);
  busyRef.current = turnStatus.kind === 'working';
  const cancelTurnRef = useRef(cancelTurn);
  cancelTurnRef.current = cancelTurn;

  // Low-level stdin tap. Two jobs:
  //   1. Diagnostic logging (gated by LCODE_DEBUG): every data chunk gets
  //      a byte-count + hex preview written to ~/.lcode/debug/lcode-<pid>.log
  //      so we can tell, the next time the UI feels frozen, whether bytes
  //      are arriving at the process at all.
  //   2. Cancellation safety net: scan each chunk for Ctrl+C (0x03) and
  //      bare ESC (0x1B not followed by `[` or `O`). When `busy` and we
  //      see one, fire `cancelTurn()` directly — bypassing Ink's keypress
  //      pipeline entirely. Ink's existing useInput handler still does the
  //      same job in normal conditions; this is the redundant path that
  //      survives even if Ink stops dispatching keypress events under heavy
  //      stream load.
  useEffect(() => {
    const stdin = process.stdin;
    if (!stdin.isTTY) return;
    if (isDebugEnabled()) {
      const path = debugLogPath();
      // Render to scrollback so the user knows where the log went without
      // having to dig through env-var docs.
      process.stderr.write(`[lcode] debug log: ${path}\n`);
    }
    const handler = (data: Buffer | string) => {
      // stdin emits Buffer by default but switches to string once any
      // listener has called setEncoding (Ink's keypress parser does this
      // on some paths). Normalize to Buffer so the byte-level scan below
      // works regardless of which form arrived.
      const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
      if (isDebugEnabled()) {
        const preview = buf.subarray(0, Math.min(16, buf.length)).toString('hex');
        debugLog('stdin', { bytes: buf.length, preview, busy: busyRef.current });
      }
      if (!busyRef.current) return;
      // Ctrl+C: byte 0x03 anywhere in the chunk.
      if (buf.includes(0x03)) {
        debugLog('cancel_via_stdin_tap', { trigger: 'ctrl_c' });
        cancelTurnRef.current();
        return;
      }
      // Bare ESC: a 0x1B that is NOT followed by `[` (CSI) or `O` (SS3).
      // Single-byte chunks of just \x1b also count.
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] !== 0x1b) continue;
        const next = i + 1 < buf.length ? buf[i + 1] : -1;
        if (next === 0x5b || next === 0x4f) continue; // `[` or `O`
        debugLog('cancel_via_stdin_tap', { trigger: 'escape' });
        cancelTurnRef.current();
        return;
      }
    };
    stdin.on('data', handler);
    return () => {
      stdin.off('data', handler);
    };
  }, []);

  // Render-rate telemetry (debug-only). A render-storm hypothesis for the
  // input-dropping bug predicts very high render counts during long
  // streams; logging the count + timestamp lets us correlate stuck typing
  // with render frequency from the next repro.
  const renderCountRef = useRef(0);
  const lastRenderLogRef = useRef(0);
  if (isDebugEnabled()) {
    renderCountRef.current += 1;
    const now = Date.now();
    if (now - lastRenderLogRef.current >= 1000) {
      debugLog('render', {
        count: renderCountRef.current,
        busy: turnStatus.kind === 'working',
      });
      renderCountRef.current = 0;
      lastRenderLogRef.current = now;
    }
  }

  const lastEscRef = useRef<number>(0);
  const lastCtrlCRef = useRef<number>(0);
  useInput(
    (inputChar, key) => {
      if (isDebugEnabled()) {
        debugLog('ink_input', {
          char: inputChar.length <= 4 ? inputChar : `${inputChar.slice(0, 4)}…`,
          esc: key.escape,
          ctrl: key.ctrl,
          ret: key.return,
          busy: busyRef.current,
        });
      }
      // MultilineInput consumed a Shift/Alt+Enter byte sequence — drop the
      // residual events Ink dispatched for the same chunk so we don't, e.g.,
      // double-tap-clear on the leading ESC.
      if (inputConsumedRef.current) return;
      if (key.ctrl && inputChar === 'c') {
        if (busy) {
          // First Ctrl+C while working cancels the turn — same as ESC.
          // Reset the double-press window so the next press doesn't kill
          // the app immediately after.
          cancelTurn();
          lastCtrlCRef.current = 0;
          return;
        }
        // When idle, require two presses within 500ms to exit. Prevents
        // accidental kills from a stray Ctrl+C.
        const now = Date.now();
        if (now - lastCtrlCRef.current < 500) {
          exit();
          return;
        }
        lastCtrlCRef.current = now;
        return;
      }
      if (key.ctrl && inputChar === 'o') {
        setShowThinking((s) => !s);
        return;
      }
      if (key.escape) {
        if (busy) {
          cancelTurn();
          lastEscRef.current = 0;
          return;
        }
        const now = Date.now();
        if (now - lastEscRef.current < 500) {
          replaceInput('');
          setHistoryIdx(null);
          draftRef.current = '';
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
      // Prompt history navigation (up = older, down = newer). Only active
      // when not busy, the slash popup isn't claiming the arrows, and the
      // input is single-line — multi-line inputs use up/down to move the
      // cursor between lines (handled inside MultilineInput).
      if (!busy && !slashOpen && !input.includes('\n')) {
        const history = historyRef.current;
        if (key.upArrow && history.length > 0) {
          if (historyIdx === null) {
            draftRef.current = input;
            const idx = history.length - 1;
            setHistoryIdx(idx);
            replaceInput(history[idx]!);
          } else if (historyIdx > 0) {
            const idx = historyIdx - 1;
            setHistoryIdx(idx);
            replaceInput(history[idx]!);
          }
          return;
        }
        if (key.downArrow && historyIdx !== null) {
          if (historyIdx < history.length - 1) {
            const idx = historyIdx + 1;
            setHistoryIdx(idx);
            replaceInput(history[idx]!);
          } else {
            setHistoryIdx(null);
            replaceInput(draftRef.current);
          }
          return;
        }
      }
    },
    { isActive: process.stdin.isTTY === true },
  );

  const onSubmitRef = useRef<((prompt: string) => Promise<void>) | null>(null);
  // Set by `sendUserPrompt` when the next user turn should be rendered as
  // something other than the default `user_prompt` block (e.g. a `skill_use`
  // summary). Consumed and cleared on the next onSubmit entry. Also signals
  // "synthetic prompt" — skip history recording so the original /<name>
  // typed input stays in up-arrow recall, not the rendered SKILL.md body.
  const pendingDisplayBlockRef = useRef<UiBlock | null>(null);
  const onSubmit = useCallback(
    async (prompt: string) => {
      let trimmed = prompt.trim();
      if (!trimmed || busy) return;
      setInput('');
      const displayOverride = pendingDisplayBlockRef.current;
      pendingDisplayBlockRef.current = null;
      // Record in history (skip consecutive dupes) and reset navigation.
      // Skip when this is a synthetic prompt fired by the slash dispatcher.
      const history = historyRef.current;
      if (!displayOverride && history[history.length - 1] !== trimmed) {
        history.push(trimmed);
      }
      setHistoryIdx(null);
      draftRef.current = '';

      // Per-submission skills refresh: re-discover from disk and re-read the
      // enabled set so mid-session edits propagate to this and subsequent
      // turns. Use the LOCAL freshSkills/freshEnabled values for the slash
      // context and the query() options — React state updates are async.
      let freshSkills = skills;
      let freshEnabled = enabledSkillNames;
      try {
        const root = projectRootRef.current ?? (await findProjectRoot(cwd));
        projectRootRef.current = root;
        const [discovered, enabled] = await Promise.all([
          loadSkills(cwd),
          loadEnabled(root),
        ]);
        freshSkills = discovered;
        freshEnabled = enabled;
        setSkills(discovered);
        setEnabledSkillNames(enabled);
      } catch {
        // Disk read failures fall back to the last in-memory snapshot.
      }

      // If the slash popup is open with at least one match, Enter runs the
      // highlighted command — even if the user only typed `/` or a partial
      // prefix that doesn't match a command name exactly.
      if (!displayOverride && isSlashPopupOpen(trimmed)) {
        const matches = matchCommands(getSlashQuery(trimmed), freshSkills, freshEnabled);
        const selected = matches[slashIdx] ?? matches[0];
        if (selected) trimmed = '/' + selected.name;
      }

      // Synthetic prompts (e.g. skill bodies from sendUserPrompt) skip the
      // slash dispatcher even if the body happens to start with `/`.
      if (!displayOverride && trimmed.startsWith('/')) {
        await maybeRunSlashCommand(trimmed, {
          cwd,
          config,
          contextWindow: effectiveContextWindow,
          sessionId,
          currentModel,
          setCurrentModel,
          addBlock: (block) => setBlocks((b) => [...b, block]),
          clearSession: () => {
            setBlocks([]);
            setSessionId(undefined);
            setTokensUsed(0);
            setTokensUsedVerified(false);
            setTurnStatus({ kind: 'idle' });
            attachmentsRef.current = new Map();
            pastedTextsRef.current = new Map();
            pasteCounterRef.current = 0;
          },
          openResumePicker: () => setPickerOpen(true),
          openModelPicker: () => setModelPickerOpen(true),
          openMcpPicker: () => setMcpPickerOpen(true),
          openContextPicker: () => setContextPickerOpen(true),
          openSkillsPicker: () => setSkillsPickerOpen(true),
          skills: freshSkills,
          enabledSkillNames: freshEnabled,
          sendUserPrompt: (text, displayBlock) => {
            // Kick off a fresh user turn with the rendered skill body. Runs
            // through the same onSubmit path so token accounting, abort
            // handling, and query setup are identical to a typed prompt.
            // The optional displayBlock replaces the default user_prompt UI
            // block, keeping the rendered SKILL.md body out of the transcript.
            if (displayBlock) pendingDisplayBlockRef.current = displayBlock;
            void onSubmitRef.current?.(text);
          },
          runCompactNow,
          mcpManager: mcpManagerRef.current!,
          exit,
        });
        return;
      }

      // Expand any `[Pasted text #N +M lines]` placeholders back to the
      // original pasted body. The displayed prompt block and the message
      // sent to the model both use the expanded form, so the conversation
      // history stays self-contained (you can read what was pasted without
      // any out-of-band state).
      trimmed = expandPastedTexts(trimmed, pastedTextsRef.current);
      pastedTextsRef.current = new Map();
      pasteCounterRef.current = 0;

      // Build the structured user content from the trimmed text + any
      // pasted-image attachments. If no images, falls through to the
      // existing string path. Once consumed, clear the attachments map so
      // the next buffer starts fresh.
      const userContent = buildUserContent(trimmed, attachmentsRef.current);
      attachmentsRef.current = new Map();

      const userBlock: UiBlock = displayOverride ?? { kind: 'user_prompt', text: trimmed };
      setBlocks((b) => [...b, userBlock]);
      const startedAt = Date.now();
      setTurnStatus({ kind: 'working', startedAt });
      // Token accounting for the user prompt happens via drainStream when
      // the loop yields the SDKUserMessage for it.

      const ctl = new AbortController();
      abortRef.current = ctl;
      lastPromptRef.current = trimmed;
      cancelledRef.current = false;
      // Ensure the n_ctx probe has resolved before locking the
      // contextWindow into the loop. Without this, a fast-typing user can
      // submit before the mount-time probe returns, anchoring the
      // multi-turn loop's compaction threshold to the static
      // LCODE_CONTEXT_WINDOW fallback for the entire run — even after the
      // statusline later flips to the probed n_ctx.
      let probedContextWindow = health?.contextWindow ?? null;
      if (probedContextWindow === null) {
        try {
          const h = await probeLlm(config, undefined, currentModel);
          setHealth(h);
          probedContextWindow = h.contextWindow;
        } catch {
          // Probe failed — fall through to the config default below.
        }
      }
      const runContextWindow = probedContextWindow ?? config.contextWindow;
      try {
        const stream = query({
          prompt: userContent,
          cwd,
          model: currentModel,
          abortController: ctl,
          resume: sessionId,
          includePartialMessages: true,
          // Override config.contextWindow with the probed n_ctx so the
          // auto-compaction threshold matches the actual server limit, not
          // the env-var fallback. Without this, compaction never fires when
          // the loaded model has a smaller window than LCODE_CONTEXT_WINDOW.
          config: { ...config, contextWindow: runContextWindow },
          claudeMdFiles,
          agentFiles,
          skills: freshSkills.filter((s) => freshEnabled.has(s.name)),
          mcpManager: mcpManagerRef.current!,
          overrideSystemPrompt,
          enableThinking,
        });
        await drainStream(stream, setBlocks, setSessionId, setTokensUsed, setTokensUsedVerified);
      } catch (err) {
        // Suppress error rendering when the user cancelled — the
        // "Interrupted" status replaces it.
        if (!cancelledRef.current) {
          const msg = err instanceof Error ? err.message : String(err);
          setBlocks((b) => [...b, { kind: 'error', text: msg }]);
        }
      } finally {
        const durationMs = Date.now() - startedAt;
        if (cancelledRef.current) {
          setTurnStatus({ kind: 'interrupted', durationMs });
          replaceInput(lastPromptRef.current);
          cancelledRef.current = false;
        } else {
          setTurnStatus({ kind: 'done', durationMs });
        }
        abortRef.current = null;
      }
    },
    [busy, config, effectiveContextWindow, cwd, sessionId, slashIdx, claudeMdFiles, agentFiles, currentModel, exit, replaceInput, skills, enabledSkillNames, runCompactNow, overrideSystemPrompt, enableThinking, health],
  );
  onSubmitRef.current = onSubmit;

  const headerItems = useMemo<HeaderItem[]>(() => {
    return health ? [{ kind: 'banner', health }] : [];
  }, [health]);

  return (
    <Box flexDirection="column">
      <Static items={headerItems}>
        {(item, i) => (
          <Box key={i}>
            <Banner config={config} cwd={cwd} health={item.health} />
          </Box>
        )}
      </Static>

      {/* Live banner with spinner while the probe is in flight; once
          health resolves, the Static slot above commits the final
          banner (with badge) into scrollback and this stops rendering. */}
      {health === null && <Banner config={config} cwd={cwd} health={null} />}

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
          ) : turnStatus.kind === 'interrupted' ? (
            <Text color="red">* Interrupted in {formatDuration(turnStatus.durationMs)}</Text>
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
            replaceInput('');
            setBlocks((b) => [
              ...b,
              { kind: 'slash_output', text: `* model set to ${m}` },
            ]);
          }}
          onCancel={() => {
            setModelPickerOpen(false);
            replaceInput('');
          }}
        />
      ) : mcpPickerOpen ? (
        <McpPicker
          mcpManager={mcpManagerRef.current!}
          onCancel={() => {
            setMcpPickerOpen(false);
            replaceInput('');
          }}
        />
      ) : skillsPickerOpen ? (
        <SkillsPicker
          skills={skills}
          enabled={enabledSkillNames}
          onToggle={async (name) => {
            try {
              const root = projectRootRef.current ?? (await findProjectRoot(cwd));
              projectRootRef.current = root;
              const next = await setEnabled(root, name, !enabledSkillNames.has(name));
              setEnabledSkillNames(next);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              setBlocks((b) => [
                ...b,
                { kind: 'error', text: `Failed to toggle skill ${name}: ${msg}` },
              ]);
            }
          }}
          onCancel={() => {
            setSkillsPickerOpen(false);
            replaceInput('');
          }}
        />
      ) : contextPickerOpen ? (
        <ContextPicker
          blocks={blocks}
          tools={[
            ...BUILTIN_TOOLS,
            ...(mcpManagerRef.current?.tools() ?? []),
          ]}
          claudeMdFiles={claudeMdFiles}
          agentFiles={agentFiles}
          cwd={cwd}
          contextWindow={effectiveContextWindow}
          tokensUsed={tokensUsed}
          onCompact={runCompactNow}
          onCancel={() => setContextPickerOpen(false)}
        />
      ) : (
        <>
          <Box>
            {process.stdin.isTTY ? (
              <MultilineInput
                key={inputKey}
                value={input}
                onChange={handleInputChange}
                onSubmit={onSubmit}
                focus={!busy}
                promptColor={busy ? 'gray' : 'cyan'}
                consumedRef={inputConsumedRef}
                onPasteImage={onPasteImage}
                onPasteText={onPasteText}
              />
            ) : (
              <Text dimColor>(non-interactive: stdin is not a TTY)</Text>
            )}
          </Box>

          <Divider />

          {slashOpen ? (
            <SlashPopup
              input={input}
              selectedIdx={slashIdx}
              skills={skills}
              enabledSkillNames={enabledSkillNames}
            />
          ) : (
            <StatusLine
              folderLabel={folderLabel}
              branch={branch}
              tokensUsed={tokensUsed}
              tokensUsedVerified={tokensUsedVerified}
              contextWindow={effectiveContextWindow}
              sessionId={sessionId}
              showThinking={showThinking}
            />
          )}
        </>
      )}
    </Box>
  );
}

/**
 * Replace `[Pasted text #N +M lines]` tokens with the captured body for
 * that N. Tokens whose N isn't in the map (typed literally, or the map
 * was cleared between paste and submit) are left as-is, so they round-trip
 * back through the session JSONL without surprises.
 */
function expandPastedTexts(
  trimmed: string,
  pastes: Map<number, string>,
): string {
  if (pastes.size === 0) return trimmed;
  return trimmed.replace(PASTE_PLACEHOLDER_RE, (match, n) => {
    const body = pastes.get(Number(n));
    return body ?? match;
  });
}

/**
 * Walk the trimmed prompt for `[Image #N]` placeholders and interleave
 * text + image blocks in cursor order. Numbers without a corresponding
 * entry in the attachments map (e.g. typed literally) stay as plain text.
 * If no images attach, we collapse to a single string for the existing
 * text-only path so the common case takes no allocations beyond the regex.
 */
function buildUserContent(
  trimmed: string,
  attachments: Map<number, { path: string; mediaType: ImageMediaType }>,
): string | ContentBlock[] {
  if (attachments.size === 0) return trimmed;

  const re = /\[Image #(\d+)\]/g;
  const blocks: ContentBlock[] = [];
  let cursor = 0;
  let hasImage = false;

  for (const match of trimmed.matchAll(re)) {
    const n = Number(match[1]);
    const att = attachments.get(n);
    if (!att) continue;
    const start = match.index ?? 0;
    const before = trimmed.slice(cursor, start);
    if (before) blocks.push(textBlock(before));
    blocks.push(imageBlockFromPath(att.path, att.mediaType));
    cursor = start + match[0].length;
    hasImage = true;
  }
  if (!hasImage) return trimmed;
  const tail = trimmed.slice(cursor);
  if (tail) blocks.push(textBlock(tail));
  return blocks;
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
  setTokensUsedVerified: React.Dispatch<React.SetStateAction<boolean>>,
) {
  for await (const msg of stream) {
    // Snap the meter to the server-reported prompt size on every assistant
    // turn. `usage.input_tokens` is ground truth and includes the system
    // prompt + tool schemas, which the local BPE estimate omits. We then
    // add the assistant's own output content (which becomes part of the
    // next round's input). For user messages (tool_results), keep the
    // incremental BPE estimate — those blocks haven't reached the server
    // yet, so the next assistant turn will re-snap and correct any drift.
    if (msg.type === 'assistant') {
      const reported = msg.message.usage?.input_tokens;
      const outTokens = sdkMessageTokens(msg);
      if (typeof reported === 'number' && reported > 0) {
        setTokensUsed(reported + outTokens);
        setTokensUsedVerified(true);
      } else {
        setTokensUsed((t) => t + outTokens);
      }
    } else if (msg.type === 'user') {
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
        // Errors thrown mid-stream (repetition, LLM failure) leave the
        // streaming thinking/text blocks in a perpetual "Thinking..." state
        // because we never reached the natural thinking_stop / assistant
        // events. Finalize them so the user sees "Thought for Ns" instead
        // of an animated header that never resolves.
        if (msg.subtype !== 'success') {
          setBlocks((b) => finalizeStreamingThinking(finalizeStreamingText(b)));
        }
        // User-initiated cancellation surfaces as the "Interrupted" status
        // line; skip the redundant error block.
        if (msg.subtype === 'error_aborted') break;
        setBlocks((b) => [
          ...b,
          { kind: 'result', subtype: msg.subtype, text: msg.error ?? msg.result },
        ]);
        break;
      case 'compaction':
        // Drop the meter by the locally-estimated saved tokens. The next
        // assistant turn re-snaps to server truth, so any drift here gets
        // corrected on the next response.
        setTokensUsed((t) => Math.max(0, t - msg.saved_tokens));
        setBlocks((b) => [
          ...b,
          {
            kind: 'compaction',
            subtype: msg.subtype,
            savedTokens: msg.saved_tokens,
            summary: msg.summary,
          },
        ]);
        break;
      case 'subagent_progress':
        setBlocks((b) => applySubagentProgress(b, msg.parent_tool_use_id, msg.event));
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

/**
 * Reconstruct `tokensUsed` from a session's JSONL after --resume.
 *
 * The server-reported `usage.input_tokens` lives on assistant SDK messages
 * and is the most accurate snapshot of the prompt size at that point. We
 * find the most-recent one and rebuild the meter as it would have been
 * mid-session: server input + the assistant's own output (now in history)
 * + BPE delta for any user messages (tool_results) that came after.
 *
 * Falls back to a pure local BPE estimate if no usage was recorded
 * (legacy sessions or never-completed turns).
 */
function restoreTokensUsed(messages: SDKMessage[]): number {
  let lastSnapIdx = -1;
  let lastUsage = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.type === 'assistant' && m.message.usage?.input_tokens) {
      lastSnapIdx = i;
      lastUsage = m.message.usage.input_tokens;
    }
  }
  if (lastSnapIdx < 0) {
    // No server snap available — use a pure local estimate.
    return messages.reduce((sum, m) => sum + sdkMessageTokens(m), 0);
  }
  const snapMsg = messages[lastSnapIdx]!;
  let total = lastUsage + sdkMessageTokens(snapMsg);
  for (let i = lastSnapIdx + 1; i < messages.length; i++) {
    total += sdkMessageTokens(messages[i]!);
  }
  return total;
}

function applySubagentProgress(
  blocks: UiBlock[],
  parentToolUseId: string,
  event: Extract<SDKMessage, { type: 'subagent_progress' }>['event'],
): UiBlock[] {
  return blocks.map((b) => {
    if (b.kind !== 'tool_call' || b.id !== parentToolUseId) return b;
    const activity = b.subagentActivity ?? {
      initialized: false,
      currentText: '',
      tools: [],
    };
    switch (event.kind) {
      case 'init':
        return { ...b, subagentActivity: { ...activity, initialized: true } };
      case 'text_delta':
        return {
          ...b,
          subagentActivity: { ...activity, currentText: activity.currentText + event.text },
        };
      case 'turn_end':
        // Don't clear here — if the turn ended with no tools (success
        // text-only response, or a degenerate failure), we want the
        // streaming text to remain visible. Clear on `tool_use` instead,
        // which signals the text was a preamble before tool dispatch.
        return b;
      case 'tool_use':
        return {
          ...b,
          subagentActivity: {
            ...activity,
            // Tools have arrived, so any streaming preamble text is no
            // longer relevant — replace with the nested tool list view.
            currentText: '',
            tools: [
              ...activity.tools,
              { id: event.id, name: event.name, input: event.input, status: 'pending' as const },
            ],
          },
        };
      case 'tool_result':
        return {
          ...b,
          subagentActivity: {
            ...activity,
            tools: activity.tools.map((t) =>
              t.id === event.tool_use_id
                ? { ...t, status: event.isError ? ('error' as const) : ('done' as const) }
                : t,
            ),
          },
        };
    }
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

