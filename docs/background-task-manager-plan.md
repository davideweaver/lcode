# Background Shell Management for lcode

## Context

Today the `Bash` tool blocks the agent loop until the spawned process exits. Long-running commands (`npm run dev`, `vitest --watch`, `docker-compose up`, file watchers) either hit the 10-minute timeout or pin the agent until the user kills them. The agent can't start a dev server and _also_ run the next tool call.

We're replicating Claude Code's three-tool model — `Bash(run_in_background)` + `BashOutput` + `KillShell` — with a TUI affordance (Ctrl+B) to background a foreground bash call mid-flight, a status-line counter, and a management panel (↓ when idle). The objective is parity with the Claude Code workflow while avoiding two well-documented Claude Code bugs: reminder-spam after kill, and orphaned "running" status after the process actually exited.

## Architecture overview

**One module owns shell state.** A new `src/core/shells.ts` exports a session-scoped `ShellRegistry` singleton holding a `Map<string, Shell>`. Every code path that interacts with background shells (the three tools, the TUI panel, the status line, the loop's reminder injection, exit cleanup) reads from / writes to this registry.

**State machine:** `running → completed | killed`. One-way. IDs are not reused. Shells live until process exit _plus_ a brief linger window (~3s) so the user can see "completed" before the row disappears from the panel and the status-line counter ticks down.

**Pull + push notification (hybrid):**

- The agent pulls output via `BashOutput` on demand (incremental — only what's new since last call for that shell).
- The loop pushes one _synthetic user message_ per state transition (`completed` / `killed`) at the start of the next turn, gated by a `notifiedCompletion` flag. Never re-injected. This is how the agent notices that a backgrounded `npm test` finished without polling.

**Ctrl+B semantics:**

- **In-flight bash:** synthesize a tool result `Running in the background (shell_id=…)`, register the still-alive child in the shells store, hand control back to the loop. The bash handler races its exit promise against a "background-requested" signal owned by `shells.ts`.
- **Idle (no bash in flight):** open the shell management panel.
- **↓ key (idle):** also opens the shell management panel (Claude Code's "↓ to manage" affordance).

## Files

### New

- `src/core/shells.ts` — registry, ring buffer, lifecycle, signal plumbing.
- `src/tools/builtin/bash-output.ts` — `BashOutput` tool.
- `src/tools/builtin/kill-shell.ts` — `KillShell` tool.
- `src/tui/shells-panel.tsx` — modal panel for managing background shells.

### Modified

- `src/tools/builtin/bash.ts` — add `run_in_background` schema field; on true, register and return immediately; on false, register-as-foreground so Ctrl+B can promote.
- `src/tools/types.ts` — add `toolUseId: string` to `ToolContext` so handlers can register themselves under the right key.
- `src/tools/registry.ts` — register `BashOutput` and `KillShell` in the default builtin set (wherever the builtins are aggregated; check `src/tools/builtin/index.ts` or equivalent).
- `src/core/loop.ts` — pass `toolUseId: tu.id` into the `ToolContext` at line 266; inject state-transition reminders (see below) at the top of the agent-turn loop, before `streamWithPartials`.
- `src/tui/app.tsx` — Ctrl+B and ↓ handlers in the `useInput` block (around lines 357–451); subscribe to `shells.subscribe(...)` for the shell count + panel state; gate exit (Ctrl+C double-press, line 369) on a confirmation prompt when shells are running.
- `src/tui/statusline.tsx` — accept `backgroundShellCount` prop; render `· N shell` (singular `1 shell`, plural `N shells`) before/after the existing thinking flag when count > 0.

## `shells.ts` data model

```ts
type ShellStatus = "running" | "completed" | "killed";

interface Shell {
  id: string; // 8-char base32, e.g. 'a3f9k2p7'
  command: string; // verbatim user-supplied command
  cwd: string; // captured at spawn
  startedAt: number; // Date.now()
  endedAt: number | null;
  status: ShellStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  proc: ChildProcess;
  stdoutTail: RingBuffer; // ~1MB or 2k lines, whichever first
  stderrTail: RingBuffer;
  unreadStdout: string; // since last BashOutput call
  unreadStderr: string;
  notifiedCompletion: boolean; // for one-shot transition reminder
  // For Ctrl+B mid-flight backgrounding of a foreground call:
  bgRequested: boolean;
  onBgRequested: (() => void) | null; // resolves the bash handler's wait
}

class ShellRegistry {
  register(shell: Shell): void;
  get(id: string): Shell | undefined;
  list(): Shell[];
  count(): number; // running only
  consumeUnread(id, filter?: RegExp): { stdout; stderr; status; exitCode };
  kill(id: string): { ok: boolean; reason?: string }; // idempotent
  requestBackground(toolUseId: string): boolean; // Ctrl+B handler entry
  cleanupAll(grace_ms: number): Promise<void>; // SIGTERM → 2s → SIGKILL
  subscribe(fn: () => void): () => void; // unsub fn for TUI
}
```

Output capture uses `proc.stdout.on('data', ...)` (matching the existing `bash.ts` pattern at lines 44–57), but appends to _both_ `unread*` and `*Tail`. `unread*` is drained when `BashOutput` is called; `*Tail` always keeps the last N for the panel.

## Tool surfaces

### `Bash` — extended schema

Add to `src/tools/builtin/bash.ts` (around line 5):

```ts
run_in_background: z
  .boolean()
  .optional()
  .describe(
    'When true, return immediately with a shell_id; the process keeps running. ' +
    'Use BashOutput to read output and KillShell to terminate. ' +
    'Use for dev servers, watchers, long builds. Default false.',
  ),
```

Handler logic (replacing the body at lines 29–74):

1. Spawn as today.
2. Always register in `shells.ts` keyed by both `id` (new) and `toolUseId` (from `ctx.toolUseId`).
3. **If `run_in_background`:** return immediately with content `Running in the background (shell_id=<id>). Use BashOutput to check on it.`
4. **Else:** await close _or_ `bgRequested` signal. If `bgRequested` resolves first, return `Backgrounded by user (shell_id=<id>).` and leave the shell alive in the registry. Otherwise, on close, mark `completed`/exit-code and return today's output payload.

Cap: if `shells.count() >= 8` when starting a new background shell, refuse with `isError: true` and a message telling the agent to call `KillShell` first. Foreground bash never hits this cap.

### `BashOutput`

```ts
schema = z.object({
  shell_id: z.string(),
  filter: z
    .string()
    .optional()
    .describe("Regex applied per stdout line; non-matching lines dropped."),
});
```

Returns:

- New stdout (filter applied if regex valid; on invalid regex, emit warning and skip filter).
- New stderr (filter not applied — always full).
- Status (`running`/`completed`/`killed`), `exit_code` if set, runtime so far.
- If status is terminal **and** `notifiedCompletion` is already set, that's fine — `BashOutput` always returns current state regardless of notification flag.
- Errors: unknown `shell_id` → `isError: true, content: 'No shell with id "X". Active: a, b, c'`.

`readOnly: true` so it can run under plan mode.

### `KillShell`

```ts
schema = z.object({ shell_id: z.string() });
```

Behavior:

- Unknown id → `isError: true`.
- Already terminal → `content: 'Shell <id> already <status>.', isError: false` (idempotent; **not** an error so the loop doesn't keep retrying).
- Running → `proc.kill('SIGTERM')`, set `status='killed'`, return `Sent SIGTERM to shell <id>.` _Don't_ await exit — return synchronously to the agent.

`readOnly: false`.

## Loop integration — state-transition reminders

In `src/core/loop.ts`, at the top of the agent-turn loop (just before the next `streamWithPartials` call), drain pending notifications:

```ts
const transitions = shells
  .list()
  .filter((s) => s.status !== "running" && !s.notifiedCompletion);
if (transitions.length > 0) {
  const lines = transitions.map((s) => {
    s.notifiedCompletion = true;
    const exit =
      s.exitCode != null ? `exit ${s.exitCode}` : (s.signal ?? "killed");
    return `- shell ${s.id} (${s.status}, ${exit}): ${s.command.slice(0, 80)}`;
  });
  history.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `<background-shell-update>\n${lines.join("\n")}\n</background-shell-update>`,
      },
    ],
  });
}
```

Critical: each transition flips `notifiedCompletion` exactly once. No re-injection on subsequent turns. This is the failure mode flagged in the spec and the Claude Code bug reports.

## TUI changes

### Status line

Add after `showThinking` rendering at `statusline.tsx:53`:

```tsx
{
  backgroundShellCount > 0 && (
    <Text color="cyan">
      {" "}
      · {backgroundShellCount} shell{backgroundShellCount === 1 ? "" : "s"}
    </Text>
  );
}
```

App subscribes to `shells.subscribe(forceRender)` and reads `shells.count()` for the prop.

### Ctrl+B / ↓ handler in `app.tsx`

Inside the existing `useInput` (after the `key.escape` branch around line 403, before the slash-popup branch):

```ts
if (key.ctrl && inputChar === "b") {
  if (busy && shells.requestBackground(currentToolUseIdRef.current)) {
    // Tool result will arrive normally as a synthetic "Backgrounded" result.
    return;
  }
  if (shells.count() > 0) setShellsPanelOpen(true);
  return;
}
if (!busy && !slashOpen && key.downArrow && shells.count() > 0) {
  setShellsPanelOpen(true);
  return;
}
```

Track `currentToolUseIdRef` from the partial-assistant `tool_use_start` events that already drive the `tool_call` block at `app.tsx:732–743` (capture the id of the most recently started, not-yet-resolved bash tool use).

### Shells panel modal

`src/tui/shells-panel.tsx`, modeled on the existing pickers (`ContextPicker` etc., `app.tsx` lines 593–668):

- Bindings: `←`/`Esc`/`Enter`/`Space` close, `↑`/`↓` navigate, `x` kill selected.
- Per row: `[●/✓/✗] <id>  <runtime>  <command (truncated)>` — colors green/gray/red.
- Bottom pane: last ~12 lines of `stdoutTail` for the selected shell. Live-updating via `shells.subscribe`.

### Exit confirmation

User chose "Prompt user" for the exit cleanup question. Replace the current `exit()` call at `app.tsx:370`:

```ts
if (shells.count() > 0) {
  setExitConfirmOpen(true);
  return;
}
exit();
```

Exit confirm modal: `N shells still running. Kill them and exit? [y/N]`. Yes → `await shells.cleanupAll(2000)` then exit. No / Esc → close modal, keep session.

On `process.on('SIGINT'/'SIGTERM')` at the top level (wherever the binary is wired up — likely `bin/lc.ts`), call `shells.cleanupAll(2000)` synchronously-ish before exit, as a safety net for non-graceful exits.

## Build order (matches the spec)

1. `shells.ts` registry + ring buffer + non-blocking readers.
2. `Bash` extended with `run_in_background` (foreground path unchanged).
3. `BashOutput` tool with incremental delivery + filter regex.
4. `KillShell` with idempotent semantics.
5. Status-line counter + subscribe wiring.
6. Ctrl+B mid-flight backgrounding + `bgRequested` signal in `bash.ts`.
7. Shells panel modal + ↓ binding.
8. State-transition reminder injection in `loop.ts`.
9. Exit-confirm modal + `cleanupAll` on signals.

Each step is independently testable. Keep ringbuffer and tool plumbing under unit tests; UX is verified manually.

## Verification

1. **Unit:** `vitest run` over a new `src/core/shells.test.ts` covering registration, incremental output consumption, filter regex, idempotent kill, transition flag. Plus `src/tools/builtin/bash.test.ts` covering: `run_in_background:true` returns within 100ms, foreground call with Ctrl+B simulation returns "Backgrounded".
2. **Integration via `npm run dev`:**
   - Tell the agent: `start the dev server in the background`. Expect `shell_id=...` immediately. `npm run typecheck` should still respond.
   - Status line shows `· 1 shell`. Press ↓ → panel opens, shows the dev-server tail. Press `x` → status flips to killed, count drops.
   - Tell the agent: `run npm test`. While it's running, press Ctrl+B. Tool result is `Backgrounded by user`. Status line shows `· 1 shell`. Wait for tests to finish. Next agent turn includes the `<background-shell-update>` block.
   - With a shell running, press Ctrl+C twice. Confirm modal appears. `y` → shell dies, app exits. `n` → app stays.
3. **Type/lint:** `npm run typecheck` clean.
4. **Failure modes to deliberately exercise:** soft cap (start 9 bg shells), invalid regex in `BashOutput.filter`, `KillShell` on already-killed id (must not be `isError`), `BashOutput` on unknown id, two consecutive transitions in one shell (must not double-notify).
