import { Box, Text, useStdout } from "ink";
import { useEffect, useState } from "react";
import { MarkdownText } from "./markdown.js";
import { getTheme } from "./theme.js";
import type { UiBlock } from "./types.js";

/**
 * Slightly darker than ANSI dim — readable on dark themes without
 * disappearing into the background. Used for de-emphasized text.
 */
export const MUTED = "gray";

const CWD = process.cwd();
const CWD_PREFIX = CWD.endsWith("/") ? CWD : CWD + "/";

// Display-only: rewrite absolute paths under cwd to their relative form.
// Tool inputs/outputs sent to the model keep their absolute paths.
function relativizeCwd(s: string): string {
  if (!s.includes(CWD_PREFIX)) return s;
  return s.split(CWD_PREFIX).join("");
}

export function BlockList({
  blocks,
  showThinking = false,
}: {
  blocks: UiBlock[];
  showThinking?: boolean;
}) {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} showThinking={showThinking} />
      ))}
    </Box>
  );
}

function BlockView({
  block,
  showThinking,
}: {
  block: UiBlock;
  showThinking: boolean;
}) {
  switch (block.kind) {
    case "user_prompt":
      return <UserPromptBlock text={block.text} />;
    case "assistant_text":
      return (
        <Box marginTop={1} flexDirection="column">
          <MarkdownText>{block.text}</MarkdownText>
          {block.streaming && <Text color={MUTED}>▋</Text>}
        </Box>
      );
    case "thinking": {
      const elapsedSec = block.streaming
        ? Math.max(0, Math.floor((Date.now() - block.startedAt) / 1000))
        : Math.max(0, Math.round((block.durationMs ?? 0) / 1000));
      const header = block.streaming
        ? `✻ Thinking... (${elapsedSec}s)`
        : `* Thought for ${elapsedSec}s`;
      // Body is only ever shown when the global toggle is on. While
      // streaming we still hide content so the user only sees the timer
      // — matches Claude Code's collapsed-by-default behavior.
      const showBody = showThinking;
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color={MUTED} italic>
            {header}
            {!block.streaming && !showThinking && (
              <Text color={MUTED}> (ctrl+o to expand)</Text>
            )}
          </Text>
          {showBody && block.text && (
            <Box marginLeft={2}>
              <Text color={MUTED}>{block.text}</Text>
            </Box>
          )}
        </Box>
      );
    }
    case "tool_call": {
      const color =
        block.status === "pending"
          ? "yellow"
          : block.status === "error"
            ? "red"
            : "green";
      const indicator =
        block.status === "pending" ? <BlinkingDot color={color} /> : <Text color={color}>●</Text>;
      const mcp = parseMcpName(block.name);
      if (mcp) {
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color={color}>
              {indicator} Calling <Text bold>{mcp.server}</Text>
              <Text color={MUTED}> · {mcp.tool}</Text>
            </Text>
            {block.status !== "pending" && (
              <McpToolOutput
                result={block.result ?? ""}
                expanded={showThinking}
              />
            )}
          </Box>
        );
      }
      if (block.name === "WebFetch") {
        const url = typeof block.input.url === "string" ? block.input.url : "";
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color={color}>
              {indicator} <Text bold>Fetch</Text>
              <Text color={MUTED}>({url})</Text>
            </Text>
            <WebFetchOutput
              status={block.status}
              result={block.result ?? ""}
              expanded={showThinking}
            />
          </Box>
        );
      }
      if (block.name === "WebSearch") {
        const query = typeof block.input.query === "string" ? block.input.query : "";
        return (
          <Box flexDirection="column" marginTop={1}>
            <Text color={color}>
              {indicator} <Text bold>Web Search</Text>
              <Text color={MUTED}>(&quot;{query}&quot;)</Text>
            </Text>
            <WebSearchOutput
              query={query}
              status={block.status}
              result={block.result ?? ""}
              expanded={showThinking}
            />
          </Box>
        );
      }
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color}>
            {indicator} <Text bold>{block.name}</Text>
            <Text color={MUTED}>({summarizeInput(block.input)})</Text>
          </Text>
          {block.status !== "pending" && (
            <ToolOutputBody
              name={block.name}
              input={block.input}
              result={block.result ?? ""}
              expanded={showThinking}
            />
          )}
        </Box>
      );
    }
    case "result":
      if (block.subtype === "success") return null;
      return (
        <Box marginTop={1}>
          <Text color="red">[{block.subtype}]</Text>
          {block.text && <Text> {block.text}</Text>}
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">error: {block.text}</Text>
        </Box>
      );
    case "slash_output":
      return (
        <Box marginTop={1}>
          <Text color={MUTED}>{block.text}</Text>
        </Box>
      );
    case "compaction": {
      const tierLabel = block.subtype === "tier1" ? "tier 1 — tool results truncated" : "tier 2 — summarized";
      const saved = block.savedTokens > 0 ? ` (~${formatBrief(block.savedTokens)} tokens reclaimed)` : "";
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">
            * compacted: {tierLabel}
            <Text color={MUTED}>{saved}</Text>
          </Text>
          {block.summary && (
            <Box marginLeft={2} marginTop={0}>
              <Text color={MUTED}>{firstLines(block.summary, 4)}</Text>
            </Box>
          )}
        </Box>
      );
    }
  }
}

function formatBrief(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function firstLines(s: string, max: number): string {
  const lines = s.split("\n").slice(0, max);
  if (s.split("\n").length > max) lines.push("…");
  return lines.join("\n");
}

const PREVIEW_LINES = 5;

function ToolOutputBody({
  name,
  input: _input,
  result,
  expanded,
}: {
  name: string;
  input: Record<string, unknown>;
  result: string;
  expanded: boolean;
}) {
  // Read: always show just the line count — the file content is already
  // in the model's context and rarely useful in the transcript itself.
  if (name === "Read") {
    return (
      <Box marginLeft={2}>
        <Text color={MUTED}>Read {readOutputLineCount(result)} lines</Text>
      </Box>
    );
  }
  // Write: keep the short confirmation message lcode's tool returns.
  if (name === "Write") {
    return (
      <Box marginLeft={2}>
        <Text color={MUTED}>{relativizeCwd(truncate(result, 600))}</Text>
      </Box>
    );
  }
  // Everything else (Read when expanded, Edit, Glob, Grep, Bash, MCP, ...):
  // first PREVIEW_LINES rows, then a "+X lines (ctrl+o to expand)" hint
  // unless the global toggle is already on.
  const lines = result.split("\n");
  const shown = expanded ? lines : lines.slice(0, PREVIEW_LINES);
  const remaining = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((line, i) => (
        <Text key={i} color={MUTED}>
          {relativizeCwd(line) || " "}
        </Text>
      ))}
      {remaining > 0 && (
        <Text color={MUTED}>
          … +{remaining} {remaining === 1 ? "line" : "lines"} (ctrl+o to expand)
        </Text>
      )}
    </Box>
  );
}

/**
 * Compact one-liner output for MCP tool calls. Newlines and whitespace are
 * collapsed so a single quote-delimited preview wraps to the terminal
 * naturally; long results get truncated with the ctrl+o hint.
 */
const MCP_PREVIEW_CHARS = 240;

function McpToolOutput({
  result,
  expanded,
}: {
  result: string;
  expanded: boolean;
}) {
  const flat = result.replace(/\s+/g, " ").trim();
  if (flat === "") {
    return (
      <Box marginLeft={2}>
        <Text color={MUTED}>└ (no output)</Text>
      </Box>
    );
  }
  if (expanded) {
    return (
      <Box flexDirection="column" marginLeft={2}>
        {result.split("\n").map((line, i) => (
          <Text key={i} color={MUTED}>
            {line || " "}
          </Text>
        ))}
      </Box>
    );
  }
  const truncated = flat.length > MCP_PREVIEW_CHARS;
  const preview = truncated ? flat.slice(0, MCP_PREVIEW_CHARS - 1) + "…" : flat;
  return (
    <Box marginLeft={2} flexDirection="column">
      <Text color={MUTED}>
        └ &quot;{preview}&quot;
      </Text>
      {truncated && (
        <Text color={MUTED}>  (ctrl+o to expand)</Text>
      )}
    </Box>
  );
}

function BlinkingDot({ color }: { color: string }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const id = setInterval(() => setOn((v) => !v), 500);
    return () => clearInterval(id);
  }, []);
  return on ? <Text color={color}>●</Text> : <Text> </Text>;
}

function WebFetchOutput({
  status,
  result,
  expanded,
}: {
  status: "pending" | "done" | "error";
  result: string;
  expanded: boolean;
}) {
  let summary: string;
  let body = result;
  if (status === "pending") {
    summary = "Fetching...";
  } else if (status === "error") {
    const flat = result.replace(/\s+/g, " ").trim();
    summary = flat || "Fetch failed";
  } else {
    const meta = parseFetchMeta(result);
    if (meta) {
      summary = `Received ${formatBytes(meta.bytes)} (${meta.status} ${meta.statusText})`;
      body = meta.rest;
    } else {
      summary = "Fetched";
    }
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={MUTED}>└ {summary}</Text>
      {expanded && status === "done" && body.trim() !== "" && (
        <Box flexDirection="column" marginLeft={2}>
          {body.split("\n").map((line, i) => (
            <Text key={i} color={MUTED}>
              {line || " "}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function parseFetchMeta(
  result: string,
): { status: number; statusText: string; bytes: number; rest: string } | null {
  const nl = result.indexOf("\n");
  const head = nl >= 0 ? result.slice(0, nl) : result;
  const m = head.match(/^\[lcode-fetch\] status=(\d+) statusText=(\S+) bytes=(\d+)$/);
  if (!m) return null;
  return {
    status: parseInt(m[1]!, 10),
    statusText: m[2]!,
    bytes: parseInt(m[3]!, 10),
    rest: nl >= 0 ? result.slice(nl + 1) : "",
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function WebSearchOutput({
  query,
  status,
  result,
  expanded,
}: {
  query: string;
  status: "pending" | "done" | "error";
  result: string;
  expanded: boolean;
}) {
  let summary: string;
  if (status === "pending") {
    summary = `Searching for "${query}"`;
  } else if (status === "error") {
    const flat = result.replace(/\s+/g, " ").trim();
    summary = flat || `Search failed for "${query}"`;
  } else {
    const count = (result.match(/^\d+\.\s/gm) || []).length;
    summary =
      count > 0
        ? `Found ${count} result${count === 1 ? "" : "s"} for "${query}"`
        : `No results for "${query}"`;
  }
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={MUTED}>└ {summary}</Text>
      {expanded && status === "done" && result.trim() !== "" && (
        <Box flexDirection="column" marginLeft={2}>
          {result.split("\n").map((line, i) => (
            <Text key={i} color={MUTED}>
              {line || " "}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * Split `mcp__<server>__<tool>` into its parts. Returns null for non-MCP
 * tool names. Tool names may contain hyphens (e.g. `resolve-library-id`)
 * but never `__` — anything after the second `__` is the tool name.
 */
export function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const idx = rest.indexOf("__");
  if (idx < 0) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + 2) };
}

function readOutputLineCount(result: string): number {
  // Read tool emits `[file has N lines total; showing X-Y]` on truncation.
  const summary = result.match(/\[file has (\d+) lines total/);
  if (summary?.[1]) return parseInt(summary[1], 10);
  // Otherwise count lines that have the `<num>\t` numbered prefix.
  return result.split("\n").filter((l) => /^\s*\d+\t/.test(l)).length;
}

function UserPromptBlock({ text }: { text: string }) {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;
  // Read theme at render time — LCODE_THEME is set by bin/lc.ts in its
  // async action handler, which runs *after* this module is imported.
  // Capturing at module top would freeze the wrong (default) theme.
  const theme = getTheme();
  // Each text line: `›` prefix on the first, two-space indent on
  // continuations. Padded with spaces to terminal width so the bg paints
  // edge-to-edge.
  const lines = text.split("\n");
  const rendered = lines.map((line, i) => {
    const prefix = i === 0 ? "› " : "  ";
    const full = prefix + line;
    return full.length >= width ? full : full + " ".repeat(width - full.length);
  });
  return (
    <Box marginTop={1} flexDirection="column">
      {rendered.map((row, i) => (
        <Text key={i} backgroundColor={theme.userPromptBg}>
          {row}
        </Text>
      ))}
    </Box>
  );
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return "";
  const first = entries[0]!;
  const value = stringify(first[1]);
  const head = `${first[0]}=${value}`;
  return entries.length > 1 ? `${head}, …+${entries.length - 1}` : head;
}

function stringify(v: unknown): string {
  if (typeof v === "string") {
    const rel = relativizeCwd(v);
    return rel.length > 60 ? rel.slice(0, 57) + "…" : rel;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return truncate(relativizeCwd(JSON.stringify(v)), 60);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}
