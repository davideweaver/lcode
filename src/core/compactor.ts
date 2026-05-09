import type {
  AnthropicMessage,
  ContentBlock,
  SDKCompactionMessage,
  SDKMessage,
  ToolResultBlock,
  ToolUseBlock,
} from './messages.js';
import { textBlock } from './messages.js';
import { contentBlockTokens, estimateTokens } from '../tui/tokens.js';
import { runCompletion } from './llm.js';
import { appendMessage, loadSessionMessages, openSession } from './session.js';

export interface CompactOptions {
  /** Window size used to compute the trigger threshold. */
  contextWindow: number;
  /**
   * Trigger when local-BPE-estimated *total prompt* tokens exceed this
   * fraction of contextWindow. "Total prompt" = `overheadTokens` + history.
   */
  threshold: number;
  /**
   * Tokens contributed by everything in the prompt that isn't `history` —
   * system prompt + tool schemas + CLAUDE.md. The trigger compares
   * `overheadTokens + historyTokens` against the threshold so compaction
   * fires when the *real* prompt is full, not when history alone is.
   */
  overheadTokens: number;
  /**
   * Tier 2: number of recent user/assistant turn boundaries to keep
   * verbatim through summarization. A turn boundary is a user message
   * with at least one non-empty text block.
   */
  preserveTail: number;
  /** When true, run compaction regardless of threshold. Used by `/compact`. */
  force?: boolean;
  /** Tier 2 summarizer. Same model the agent uses; no tools. */
  runCompletion: (req: {
    systemPrompt?: string;
    userPrompt: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  signal?: AbortSignal;
}

export interface CompactResult {
  history: AnthropicMessage[];
  tier: 'noop' | 'tier1' | 'tier2';
  /** Local BPE estimate of tokens freed. */
  savedTokens: number;
  /** Tier 2 only — the synthesized summary. */
  summary?: string;
  /** Tool_use ids whose tool_result content was replaced with the stub. */
  truncatedToolUseIds: string[];
}

const SUMMARY_SYSTEM_PROMPT =
  `Summarize the prior conversation between a user and a coding assistant. ` +
  `Preserve: user goals, key decisions, file paths read or edited, errors encountered, ` +
  `and outstanding TODOs. Output one bullet list, under 800 tokens. ` +
  `Do not invent content. Do not add a preamble — start with the first bullet.`;

const TIER2_PREFIX = '<COMPACTED HISTORY>\n';

export async function compact(
  history: AnthropicMessage[],
  opts: CompactOptions,
): Promise<CompactResult> {
  const startHistoryTokens = totalTokens(history);
  const startTokens = startHistoryTokens + opts.overheadTokens;
  const trigger = Math.floor(opts.contextWindow * opts.threshold);

  if (!opts.force && startTokens < trigger) {
    return {
      history,
      tier: 'noop',
      savedTokens: 0,
      truncatedToolUseIds: [],
    };
  }

  // Tier 1: size + recency aware. Preserve every tool_result paired with
  // the most-recent assistant turn (so the in-flight step stays intact,
  // parallel calls included). Among older results, stub any whose body
  // exceeds the "large" threshold; keep the small ones around for free.
  // The threshold scales with the window — ~5% — so 16k models get an
  // ~800-token cutoff while 128k models get ~6.5k.
  const recentToolUseIds = new Set<string>();
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== 'assistant') continue;
    const ids: string[] = [];
    for (const b of blocksOf(msg)) {
      if (b.type === 'tool_use') ids.push((b as ToolUseBlock).id);
    }
    if (ids.length > 0) {
      for (const id of ids) recentToolUseIds.add(id);
      break;
    }
  }

  const largeResultThreshold = Math.max(256, Math.floor(opts.contextWindow * 0.05));
  const truncatedIds: string[] = [];
  const tier1History = history.map((msg) => {
    const blocks = blocksOf(msg);
    if (!blocks.some((b) => b.type === 'tool_result')) return msg;
    return {
      ...msg,
      content: blocks.map((b) => {
        if (b.type !== 'tool_result') return b;
        if (recentToolUseIds.has(b.tool_use_id)) return b; // freshest turn — keep
        const original = blockText(b);
        if (original.length === 0) return b;
        const tokens = estimateTokens(original);
        if (tokens <= largeResultThreshold) return b; // small — keep around for free
        truncatedIds.push(b.tool_use_id);
        const stub = `[truncated tool_result: ${toolNameFor(history, b.tool_use_id)} ~${tokens} tokens elided]`;
        return { ...b, content: stub };
      }),
    };
  });

  const afterTier1History = totalTokens(tier1History);
  const afterTier1 = afterTier1History + opts.overheadTokens;
  if (afterTier1 < trigger) {
    if (truncatedIds.length === 0) {
      // Already at or under threshold and nothing to truncate (e.g. force
      // on a small history). Honest no-op.
      return { history, tier: 'noop', savedTokens: 0, truncatedToolUseIds: [] };
    }
    return {
      history: tier1History,
      tier: 'tier1',
      savedTokens: startHistoryTokens - afterTier1History,
      truncatedToolUseIds: truncatedIds,
    };
  }

  // Still over threshold — escalate to tier 2. Summarize the prefix above
  // the tail, using the post-tier1 history so the summarizer doesn't
  // re-read giant tool_results we just stubbed.
  let tailStart = findTailStart(history, opts.preserveTail);
  // Fallback: when the conversation doesn't have enough user-text prompts
  // for findTailStart to bite, just preserve the last K messages so tier 2
  // still has a prefix to work with. Without this, sessions with one long
  // multi-tool turn never escalate past tier 1.
  const FALLBACK_TAIL_MESSAGES = 4;
  if (tailStart === 0 && tier1History.length > FALLBACK_TAIL_MESSAGES) {
    tailStart = tier1History.length - FALLBACK_TAIL_MESSAGES;
  }
  const prefix = tier1History.slice(0, tailStart);
  const tail = tier1History.slice(tailStart);

  if (prefix.length === 0) {
    // Truly nothing to summarize (very short history). Honest tier 1 result.
    return {
      history: tier1History,
      tier: 'tier1',
      savedTokens: startHistoryTokens - afterTier1History,
      truncatedToolUseIds: truncatedIds,
    };
  }

  // Cap the summarizer's user-prompt size so its own call doesn't overflow
  // the model on small-window setups. Reserve ~2k for the system prompt +
  // summary output; clamp the rest. If the prefix is bigger than the cap,
  // we summarize the most recent portion of the prefix only — older content
  // is already stub-truncated by tier 1, so this is a forgivable tradeoff.
  const summarizerBudget = Math.max(1024, opts.contextWindow - 2048);
  const userPrompt = renderPrefixForSummary(prefix, summarizerBudget);

  const summary = await opts.runCompletion({
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    userPrompt,
    signal: opts.signal,
  });

  const synthetic: AnthropicMessage = {
    role: 'user',
    content: [textBlock(TIER2_PREFIX + summary)],
  };

  const tier2History: AnthropicMessage[] = [synthetic, ...tail];
  const afterTier2History = totalTokens(tier2History);

  return {
    history: tier2History,
    tier: 'tier2',
    savedTokens: startHistoryTokens - afterTier2History,
    summary,
    truncatedToolUseIds: truncatedIds,
  };
}

/** Reapply a recorded tier-1 compaction to a replayed history (used by --resume). */
export function applyTier1(
  history: AnthropicMessage[],
  truncatedToolUseIds: readonly string[],
): AnthropicMessage[] {
  if (truncatedToolUseIds.length === 0) return history;
  const ids = new Set(truncatedToolUseIds);
  return history.map((msg) => {
    const blocks = blocksOf(msg);
    if (!blocks.some((b) => b.type === 'tool_result' && ids.has(b.tool_use_id))) {
      return msg;
    }
    return {
      ...msg,
      content: blocks.map((b) => {
        if (b.type !== 'tool_result' || !ids.has(b.tool_use_id)) return b;
        const original = blockText(b);
        const tokens = estimateTokens(original);
        return {
          ...b,
          content: `[truncated tool_result: ${toolNameFor(history, b.tool_use_id)} ~${tokens} tokens elided]`,
        };
      }),
    };
  });
}

/** Build the synthetic user message a tier-2 marker injects on replay. */
export function syntheticTier2Message(summary: string): AnthropicMessage {
  return { role: 'user', content: [textBlock(TIER2_PREFIX + summary)] };
}

/**
 * Manually compact a session between turns. Loads the JSONL, applies any
 * existing compaction markers via {@link replayHistoryForCompact}, runs the
 * compactor with force=true, and appends the resulting marker back to the
 * JSONL so the next `query()` call sees the compacted state.
 */
export async function manualCompact(args: {
  sessionId: string;
  cwd: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  threshold: number;
  /** System prompt + tool schemas, in tokens. Optional; defaults to 0. */
  overheadTokens?: number;
  preserveTail?: number;
  signal: AbortSignal;
}): Promise<CompactResult & { marker?: SDKCompactionMessage }> {
  const messages = await loadSessionMessages(args.sessionId, args.cwd);
  const history = replayHistoryForCompact(messages);

  const result = await compact(history, {
    contextWindow: args.contextWindow,
    threshold: args.threshold,
    overheadTokens: args.overheadTokens ?? 0,
    preserveTail: args.preserveTail ?? 2,
    force: true,
    runCompletion: ({ systemPrompt = '', userPrompt, signal }) =>
      runCompletion({
        baseUrl: args.baseUrl,
        apiKey: args.apiKey,
        model: args.model,
        systemPrompt,
        userPrompt,
        signal: signal ?? args.signal,
      }),
    signal: args.signal,
  });

  if (result.tier === 'noop') return result;

  const marker: SDKCompactionMessage = {
    type: 'compaction',
    session_id: args.sessionId,
    subtype: result.tier,
    saved_tokens: result.savedTokens,
    summary: result.summary,
    truncated_tool_use_ids: result.truncatedToolUseIds,
  };
  const session = await openSession(args.sessionId, args.cwd);
  await appendMessage(session, marker);
  return { ...result, marker };
}

/**
 * Replay session JSONL into an `AnthropicMessage[]` honoring any prior
 * compaction markers. Mirror of `replayHistory` in query.ts, factored
 * here so the manual compactor can use the same logic without a circular
 * import. (query.ts also imports this.)
 */
export function replayHistoryForCompact(
  messages: SDKMessage[],
): AnthropicMessage[] {
  let out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.type === 'assistant') {
      out.push({ role: 'assistant', content: m.message.content });
    } else if (m.type === 'user') {
      out.push({ role: 'user', content: m.message.content });
    } else if (m.type === 'compaction') {
      if (m.subtype === 'tier1') {
        out = applyTier1(out, m.truncated_tool_use_ids);
      } else if (m.subtype === 'tier2' && m.summary) {
        out = [syntheticTier2Message(m.summary)];
      }
    }
  }
  return out;
}

function totalTokens(history: AnthropicMessage[]): number {
  let n = 0;
  for (const m of history) {
    for (const b of blocksOf(m)) n += contentBlockTokens(b);
  }
  return n;
}

function blocksOf(msg: AnthropicMessage): ContentBlock[] {
  return typeof msg.content === 'string'
    ? [textBlock(msg.content)]
    : msg.content;
}

function blockText(b: ToolResultBlock): string {
  if (typeof b.content === 'string') return b.content;
  return b.content.map((c) => c.text).join('');
}

function toolNameFor(history: AnthropicMessage[], toolUseId: string): string {
  for (const m of history) {
    for (const b of blocksOf(m)) {
      if (b.type === 'tool_use' && (b as ToolUseBlock).id === toolUseId) {
        return (b as ToolUseBlock).name;
      }
    }
  }
  return 'unknown';
}

/**
 * Walk back through history counting "real" user prompts (user messages
 * that contain at least one text block — i.e. not pure tool_result
 * acknowledgments). Returns the index where the preserved tail begins.
 * Falls back to 0 (preserve everything) if there aren't enough boundaries.
 */
function findTailStart(history: AnthropicMessage[], minPrompts: number): number {
  if (minPrompts <= 0) return history.length;
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'user') continue;
    const blocks = blocksOf(m);
    const hasUserText = blocks.some(
      (b) => b.type === 'text' && b.text.trim().length > 0,
    );
    if (!hasUserText) continue;
    count++;
    if (count >= minPrompts) return i;
  }
  return 0;
}

function renderPrefixForSummary(
  prefix: AnthropicMessage[],
  tokenBudget: number,
): string {
  const lines: string[] = [];
  for (const m of prefix) {
    const blocks = blocksOf(m);
    if (m.role === 'user') {
      for (const b of blocks) {
        if (b.type === 'text') lines.push(`USER: ${b.text}`);
        else if (b.type === 'tool_result') {
          lines.push(`TOOL_RESULT (${b.tool_use_id}): ${blockText(b)}`);
        }
      }
    } else {
      for (const b of blocks) {
        if (b.type === 'text') lines.push(`ASSISTANT: ${b.text}`);
        else if (b.type === 'tool_use') {
          lines.push(`ASSISTANT_TOOL_CALL: ${b.name}(${JSON.stringify(b.input)})`);
        } else if (b.type === 'thinking') {
          // Skip thinking — verbose and rarely worth summarizing.
        }
      }
    }
  }
  // Trim from the START of the rendered text if we're over budget, keeping
  // the most recent portion (closest to the preserved tail). Older content
  // has already been tier-1-stubbed so dropping it from the summarizer's
  // view is a forgivable tradeoff to keep the summarizer call from
  // overflowing on small-window setups.
  let rendered = lines.join('\n');
  while (estimateTokens(rendered) > tokenBudget && rendered.length > 0) {
    const cut = Math.floor(rendered.length * 0.2);
    rendered = '[earlier conversation truncated for summary]\n' + rendered.slice(cut);
    if (cut === 0) break;
  }
  return rendered;
}
