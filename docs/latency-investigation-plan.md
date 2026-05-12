# lcode Latency — MCP Is Not the Whole Story

## Context

The production interface is the interactive TUI; `-p` headless is a profiling/debug surface. The goal is "make the interactive TUI cheap to run with MCP on." The headless numbers below are diagnostic: they isolate cold-start cost from steady-state cost.

### What the timings actually reveal

| run | first LLM token | turn end |
|---|---|---|
| headless `--no-mcp`, cold | +164ms | +308ms |
| headless full MCP, **cold** | **+2511ms** | +2660ms |
| headless full MCP, **warm** (2nd run) | **+271ms** | +424ms |
| TUI full MCP, same prompt | — | **~10s** |

Two distinct problems:

**Problem 1 — MCP cold-start prefill (~2.3s, one-time per session).** With MCP enabled, the first request to llama.cpp prefills ~41 tool schemas. The second back-to-back call goes from 2511ms → 271ms because llama.cpp's prefix KV cache is hitting — the system prompt + tools array is byte-stable enough across calls. So the actual MCP tax is paid **once per cold session**, not per turn. Less urgent than it first looked.

**Problem 2 — TUI first-prompt overhead (~9s, likely once per session).** The same prompt that takes 424ms in headless takes ~10s in the TUI. Reading `src/tui/app.tsx:639-654`, the n_ctx probe runs at mount and is *only* awaited on submission if it hasn't yet resolved:

```ts
let probedContextWindow = health?.contextWindow ?? null;
if (probedContextWindow === null) {           // only if mount-time probe hasn't returned
  const h = await probeLlm(config, undefined, currentModel);
  ...
}
```

So this is a **first-prompt** tax, not a per-turn tax: the user almost always types and submits faster than `probeLlm` (`src/health.ts:73-119`, hits `/props` or `/v1/models/status`) returns, so turn 1 awaits it. **Subsequent turns should not pay this cost** — verify by sending a second prompt back-to-back in the same TUI session.

If turn 2 is still slow, there's a deeper per-turn cost we haven't identified yet. If turn 2 is fast (~500ms), the fix is just "don't block submission on the probe — use config default, snap to probed value when it arrives."

Commits to look at: `009f67c fix(tui): await n_ctx probe before locking contextWindow into agent loop`, `67d777b feat(health): probe omlx /v1/models/status for live context window`.

### MCP config detail (for reference)

`loadMcpServers` (`src/mcp/config.ts:45`) merges **three layers** — `~/.lcode/mcp.json`, project `.mcp.json`, and `~/.claude.json`. Your current state is:

| layer | servers | tools (est.) |
|---|---|---|
| `~/.lcode/mcp.json` | xerro (sse, localhost:9205) | ~8 |
| project `.mcp.json` | sentry (stdio mcp-remote), context7 (http) | ~16 |
| `~/.claude.json` | puppeteer (stdio), context7 (dedup) | ~7 |

That's **~4 servers / ~31 MCP tools**, plus ~10 builtins → **~41 tool schemas serialized into every `/v1/chat/completions` body** via `toOpenAITools()` (`src/core/llm.ts:102`). The cold-prefill tax is paid once; warm steady-state is fast. Puppeteer's `npx -y` stdio spawn may also fire eagerly even if rarely used — worth verifying.

## Ideas, Ranked

The plan is a menu — pick what you want and we'll execute. Each option is independent. **Problem 2 (TUI overhead) options come first** because they have the biggest user impact.

---

### TUI-0. Confirm the diagnosis (5 minutes, no code)

**What**: In a fresh TUI session, submit "hi", wait for it to finish, then submit "hi" again. Watch the "Done in Xs" footer for each.

- **Turn 1 fast, Turn 2 fast** → probe completed before submission; the 10s observation was something else (e.g., a Node JIT warmup the first time `lcode` runs). Move to MCP-5 / MCP-1.
- **Turn 1 slow (~10s), Turn 2 fast** → confirmed: the mount-time probe is slow and `app.tsx:645-654` awaits it on first submission. Go to TUI-2.
- **Turn 1 slow, Turn 2 also slow** → something fires per-turn that we haven't identified. Go to TUI-1 to instrument it.

**Cost**: 5 minutes. Pure observation.

---

### TUI-1. Profile the TUI's pre-query path (only if TUI-0 says we need it)

**What**: Add `mark()`-style timing breadcrumbs around the TUI submission path, mirroring headless: mount → probe resolved → user submitted → query started → first LLM token. Print to stderr behind `LCODE_DEBUG_TIMING=1`.

**Why it works**: If TUI-0 shows per-turn slowness, we need to know whether it's React render thrash, a synchronous MCP refetch, session/history disk I/O, or something else.

**Cost**: ~30 lines in `src/tui/app.tsx`. Reuse the headless `mark()` pattern.

**Tradeoff**: None — pure measurement, gated by env var.

---

### TUI-2. Make the n_ctx probe non-blocking on first submit

**What**: Today `src/tui/app.tsx:639-654` awaits the mount-time probe on first submission if it hasn't resolved. Change that to:
- always proceed with `config.contextWindow` as the run value if the probe hasn't returned
- when the probe later returns, update the statusline meter and patch the live loop's `contextWindow` (if the loop can accept it) or just let the next turn use it

The probe exists to populate the context-window indicator and tune the compaction threshold. Both are recoverable a turn later if the first turn ran with the static default.

**Why it works**: Removes the first-turn wait entirely.

**Cost**: ~40 lines. Touches `src/tui/app.tsx:639-654` and possibly `src/core/loop.ts:152` if we want the running loop to pick up the probed value mid-flight (otherwise just accept that turn 1's compaction threshold matches the env default — which is what we had before commit `009f67c`).

**Tradeoff**: Turn 1's compaction threshold may be wrong if `LCODE_CONTEXT_WINDOW` doesn't match the loaded model's actual n_ctx. That's the regression `009f67c` was meant to fix. Mitigation: still update `effectiveContextWindow` when the probe returns; the threshold is only consulted at the *end* of each turn, so even mid-turn it self-corrects for the next turn.

---

### MCP-1. User-controlled MCP allowlist persisted in TUI

**What**: The TUI already has a `/mcp` picker and `mcp-disabled.json` already persists which servers are off. Lean into that — make the default state in a fresh install "all MCP servers disabled" and let the user enable what they want via `/mcp`. Plus: print a one-time hint on first launch ("MCP servers add N tokens to every request — enable with /mcp").

**Why it works**: Most TUI users in this codebase probably don't need Sentry or Puppeteer at all. Xerro and context7 are the load-bearing ones. Letting the user pick keeps full power but removes the unused-tool tax.

**Cost**: ~20 lines. Touches `src/mcp/disabled.ts` (default state), and a small TUI welcome message.

**Tradeoff**: Slight friction on first launch — but the `/mcp` picker is already a known affordance and persistence already exists.

---

### MCP-2. Slim the tool schemas before serialization

**What**: In `toOpenAITools()` (`src/core/llm.ts:453`), strip verbose `description` fields and JSON-Schema noise (examples, `$schema`, `additionalProperties: false` where redundant, deep `oneOf` unions for optional fields). Sentry's tool descriptions in particular are long.

**Why it works**: Tokens spent on `"description": "Search for issues in Sentry. Use this when..."` are prefilled on every request. Trimming each of 16 MCP tools by ~100 tokens saves ~1.6k prefill tokens.

**Cost**: ~40 lines in `src/core/llm.ts` (extend `sanitizeSchemaForLlm`). Optional knob to keep full descriptions when `LCODE_VERBOSE_TOOLS=1`.

**Tradeoff**: LLM has less context for *when* to use each tool. Mitigation: keep first sentence of each description, drop the rest.

---

### MCP-3. Two-tier tool exposure (catalog + dispatcher)

**What**: Replace the 16 individual MCP tool schemas in the `tools` array with a single `mcp_call(server, tool, args)` dispatcher. Put a short plain-English catalog ("Sentry tools: search_issues — query the issue store; search_events — query the event stream; …") in the system prompt.

**Why it works**: Plain-English catalog is ~5x smaller than 16 JSON schemas with parameter trees. One generic tool schema replaces sixteen specific ones.

**Cost**: ~150 lines: catalog generator, dispatcher tool, JSON-schema validation at call time (since model now passes free-form args). Touches `src/mcp/manager.ts` and adds a new builtin tool.

**Tradeoff**: Local models often handle one-shot tool selection worse with free-form args. Worth A/B-testing on gemma4 specifically. This is the biggest architectural change and the one I'd defer until A+B+C are exhausted.

---

### MCP-4. Lazy MCP server connection on first use

**What**: Don't connect to MCP servers (or call `listTools`) at TUI launch. Connect on first user message that *might* need MCP, or on explicit `/mcp` action. Until then, omit MCP tools from the request entirely. The first turn (often something like "look at this file") doesn't need Sentry tools loaded.

**Why**: Right now even the puppeteer `npx -y` spawn fires before the user types their first character. Lazy connection moves that cost off the critical path.

**Cost**: ~80 lines. `McpManager.start()` becomes a no-op; first `getEnabledTools()` triggers per-server connection in parallel. `src/core/loop.ts:85-99` must accept a tools-list-producing function rather than a precomputed list, since the set grows turn-to-turn as servers come online.

**Tradeoff**: First turn the user tries to use MCP, there's a small one-time wait. Could be hidden by warming servers in background once the TUI is interactive (after the first prompt is composed, before submission).

---

### MCP-5. Audit per-server startup cost  (telemetry, no behavior change)

**What**: Surface per-server connect + `listTools()` latency, and the byte/token size each contributes to the serialized tools array. Today `[+30ms] mcp manager started` collapses 4 parallel server starts into one number. Print a line per server:

```
[+12ms] mcp/xerro    ready  tools=8   schema=4.3KB
[+28ms] mcp/context7 ready  tools=2   schema=0.6KB
[+1400ms] mcp/puppeteer ready  tools=7  schema=2.1KB
[+1500ms] mcp/sentry  ready  tools=14  schema=18.4KB
```

**Why it works**: Tells us *which* server is the cost driver before we choose which to disable. Sentry's schemas are likely the bulk; puppeteer's startup is likely the slowest.

**Cost**: ~20 lines in `McpManager.connectOne()` and `headless.ts`. Free signal, no risk.

**Tradeoff**: None. Do this first if you're unsure where to cut.

---

## Recommendation

**Investigate the TUI gap first, MCP second.** Headless warm-cache hits first token in 271ms; the TUI takes 10s on the same prompt. That 9.7s gap is the dominant user-facing problem.

Order: **TUI-0 → (TUI-2 or TUI-1) → MCP-5 → MCP-1**

1. **TUI-0** — 5-minute observation: submit two prompts back-to-back in a fresh TUI session. If turn 2 is fast, we've localized the problem to first-prompt only (very likely the n_ctx probe).
2. **TUI-2** — If TUI-0 confirms the probe, this is a one-evening fix that recovers ~9s on first prompt. Worth doing even if cold-prompt latency is rare per session.
3. **TUI-1** — Only if TUI-0 shows per-turn slowness. Instrument and dig deeper.
4. **MCP-5** — Per-server startup telemetry (~20 lines). Cheap, tells us if puppeteer's `npx -y` is also wasting time and gives schema-size numbers per server.
5. **MCP-1** — Default-off MCP allowlist, opt-in via `/mcp`. Cheapest MCP win; warm-cache numbers say nothing more aggressive is needed.

MCP-2 (slim schemas), MCP-3 (catalog/dispatcher), MCP-4 (lazy connection) stay on the shelf. The warm-cache evidence is that they'd shave the 2.3s cold-start tax which is only paid once per session — not worth the complexity until/unless someone hits a worse worst case.

## Files to Touch (for TUI-2 + MCP-5)

For **TUI-2** (non-blocking probe):
- `src/tui/app.tsx:639-654` — replace the `await probeLlm(...)` branch with: proceed using `config.contextWindow`, let the existing background probe update `health` state, statusline catches up on re-render
- `src/health.ts` — keep `probeLlm` unchanged; just stop blocking on it on the submission path

For **TUI-1** (only if needed):
- `src/tui/app.tsx` — add `mark()` instrumentation around mount, probe resolved, submit, query started, first LLM token
- Gate output behind `LCODE_DEBUG_TIMING=1`

For **MCP-5**:
- `src/mcp/manager.ts:201-226` (`connectOne`) — capture per-server `Date.now()` deltas and serialized schema byte size
- `src/headless.ts:57` — replace the single `mark('mcp manager started')` with one mark per server via a callback or event on `McpManager`

## Verification

- After **TUI-0**: we know which TUI fix path applies.
- After **TUI-2**: TUI first-turn time for "respond with 3 words" should drop from ~10s to ≤500ms — matching headless warm-cache. Subsequent turns unchanged.
- After **MCP-5**: cold launch prints per-server latency + tool count + schema bytes; we can decide if any later MCP work is worth the effort.
- After **MCP-1**: fresh install with all MCP off — cold-start first-token approaches the `--no-mcp` baseline (~165ms).
