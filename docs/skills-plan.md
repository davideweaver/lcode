# Claude Code–style Skills in lcode

## Context

lcode is a local Claude-Code-shaped harness. Today it has slash commands (`/help`, `/clear`, `/mcp`, …) and a `Tool` registry, but it has no concept of **skills** — the `.claude/skills/<name>/SKILL.md` reusable workflows that Claude Code surfaces to the model (auto-invoked via a `Skill` tool) and to the user (typed as `/skill-name`). The user already has skills authored on disk (frontend-design, xerro:\*, plus project-scoped ones) and wants lcode to discover and run them with parity to Claude Code.

Goal: lcode discovers skills at session start, advertises them to the model in the system prompt, exposes a `Skill` tool so the model can auto-invoke them, and lets the user type `/skills` to list them or `/skill-name [args]` to fire one directly. `$ARGUMENTS` substitution is supported; deeper Claude-Code preprocessing (`` !`shell` ``, positional `$0`/`$1`, `${CLAUDE_SKILL_DIR}`) is deferred.

Discovery is scoped to:

- **Project** — `<projectRoot>/.claude/skills/<name>/SKILL.md` (Claude-Code-compatible, checked in with the repo)
- **lcode user** — `~/.lcode/skills/<name>/SKILL.md` (matches the existing lcode user-scope convention used by `~/.lcode/mcp.json`)

Plugin skills (`~/.claude/plugins/cache/…`) and the standard `~/.claude/skills/` are intentionally out of scope for v1.

## 1. Discovery and data model (new module: `src/skills/`)

**`src/skills/types.ts`**

```ts
export interface SkillFrontmatter {
  name?: string; // optional override; defaults to dir name
  description?: string;
  "when-to-use"?: string; // appended to description in advertising
  "argument-hint"?: string; // shown in /skills and the popup
  "disable-model-invocation"?: boolean; // suppress from system-prompt list
  "user-invocable"?: boolean; // default true; false → hidden from /menu
}
export type SkillScope = "project" | "user";
export interface Skill {
  name: string; // canonical id, lower-kebab
  scope: SkillScope;
  source: string; // absolute path to SKILL.md
  dir: string; // absolute path to skill dir
  description: string; // empty string if missing
  whenToUse?: string;
  argumentHint?: string;
  disableModelInvocation: boolean; // resolved with default false
  userInvocable: boolean; // resolved with default true
  body: string; // SKILL.md content WITHOUT frontmatter
}
```

**`src/skills/loader.ts`** — `loadSkills(cwd, opts?): Promise<Skill[]>`

- Mirrors the layering in `src/mcp/config.ts:45` (`loadMcpServers`): higher-precedence layer wins on duplicate name; reuses `findProjectRoot(cwd)` (lift it out of `mcp/config.ts` to a shared util, or duplicate the 12-line helper — the latter is fine for v1).
- Walks each `<dir>/.claude/skills/` (or `~/.lcode/skills/`) one level deep: every immediate subdirectory containing a `SKILL.md` becomes a candidate.
- Precedence: **project beats user** (Claude Code is the same way).
- Parses frontmatter with **`gray-matter`** (already familiar pattern; add as a dep — it's tiny and pure-JS). Falls back to `name = dirname`, `description = ''` if the YAML block is missing/malformed.
- Skips on errors with `console.warn`-style sink, same as `loadMcpServers` (`opts.onWarn`).
- Returns a deduped, sorted-by-name array.

**`src/skills/render.ts`** — `renderSkillBody(skill: Skill, argsString: string): string`

- Returns `skill.body` with every literal `$ARGUMENTS` replaced by `argsString`.
- No other substitutions for v1. Frontmatter is already stripped at load time.

**Tests** (`src/skills/loader.test.ts`, `src/skills/render.test.ts`):

- Discovers a fixture skill, reads frontmatter, scopes correctly.
- Project skill shadows same-named user skill.
- Missing frontmatter → still loads with `description: ''`.
- Malformed YAML → skipped + warning.
- `$ARGUMENTS` substitution (including multiple occurrences, no-args case).

## 2. System-prompt injection

Modify **`src/prompts/system.ts`**:

- Add a new optional field to `SystemPromptArgs`: `skills?: Skill[]`.
- Add a new section emitter `buildSkillsGuidance(skills)` inserted after `buildToolGuidance(args.tools)` in `buildSystemPrompt` (system.ts:30):

  ```
  # Available Skills
  Skills are reusable, named workflows. To invoke one, call the `Skill` tool with
  `skill_name` (and optional `args`). The tool returns the skill's instructions,
  which you then follow on subsequent turns. Invoke a skill only when the user's
  request clearly matches its description.

  - **<name>** — <description> [when_to_use appended if present]
  - …
  ```

- Skills with `disableModelInvocation: true` are omitted from this list.
- If `skills` is empty/undefined, the section is skipped entirely (no header).

## 3. The `Skill` tool

New file **`src/tools/builtin/skill.ts`** — built as a factory because the skill list is session-specific (same pattern MCP-adapter tools use):

```ts
import { z } from "zod";
import { tool } from "../helper.js";
import { renderSkillBody } from "../../skills/render.js";
import type { Skill } from "../../skills/types.js";

const schema = z.object({
  skill_name: z.string().describe("Skill name as shown in the system prompt."),
  args: z
    .string()
    .optional()
    .describe("Arguments substituted into the skill body via $ARGUMENTS."),
});

export function makeSkillTool(skills: Skill[]) {
  const byName = new Map(skills.map((s) => [s.name, s] as const));
  return tool(
    "Skill",
    "Invoke a named skill (reusable workflow). Returns the skill instructions for you to follow.",
    schema,
    (input) => {
      const skill = byName.get(input.skill_name);
      if (!skill) {
        const known = [...byName.keys()].join(", ") || "(none)";
        return {
          content: `Unknown skill "${input.skill_name}". Known: ${known}`,
          isError: true,
        };
      }
      if (skill.disableModelInvocation) {
        return {
          content: `Skill "${skill.name}" is user-only.`,
          isError: true,
        };
      }
      return { content: renderSkillBody(skill, input.args ?? "") };
    },
    { readOnly: true },
  );
}
```

Wired in **`src/tui/app.tsx`** at the two call sites that build `tools` (app.tsx:425 and app.tsx:753), appended after `BUILTIN_TOOLS` and MCP tools when `skills.length > 0`.

## 4. Slash command — `/skills` and `/<skill-name>` fallback

Modify **`src/tui/slash.tsx`**:

1. **Extend `SlashContext`** with `skills: Skill[]` (added at the dispatch site in `app.tsx:562` and the sub-agent invocation context in `app.tsx:650`).

2. **Add `/skills`** to the `COMMANDS` array — pure read-only listing:

   ```
   Skills (5 discovered):

   Project (./.claude/skills/):
     /init           Initialize a new CLAUDE.md file…

   User (~/.lcode/skills/):
     /frontend-design   Create distinctive, production-grade frontend interfaces…
     /simplify          Review changed code for reuse, quality, and efficiency…
   ```

   If empty: emit a one-liner explaining where to put SKILL.md files.

3. **Fallback in `maybeRunSlashCommand`** (slash.tsx:178) — when no built-in command matches, look up the name in `ctx.skills` (filtered by `userInvocable !== false`). On match, emit the rendered SKILL.md body as a synthetic **user prompt** so the agent loop picks it up as the first turn's content:
   - Implementation: instead of executing the slash command in-place, the fallback path calls a new `ctx.sendUserPrompt(text)` callback (added to `SlashContext`) that App wires to `onSubmit` minus the slash re-check. The text is the rendered body, prefixed with a one-line `<system-reminder>` block so the model knows this came from a user-invoked skill:

     ```
     <system-reminder>Skill invoked by user: <name>. Follow these instructions.</system-reminder>

     <rendered SKILL.md body>
     ```

   - This keeps the body inside the regular conversation history (it survives compaction the same way as a normal user turn, and shows up in `/resume`), while still flagging its provenance to the model.
   - Unknown names continue to emit the existing "Unknown command" message.

4. **Popup matching** (`matchCommands`, slash.tsx:169): extend to also rank skill names. Built-ins come first, then `userInvocable` skills. `SlashPopup` renders them in the same list but with a faint `[skill]` tag on the right so the user can distinguish them. Plugin-style colon names (e.g. `xerro:notes`) just work — `slash.tsx:185`'s split-on-whitespace already keeps them as one token.

## 5. App-level wiring (`src/tui/app.tsx`)

- Import `loadSkills` and call it in the same `useEffect` that loads CLAUDE.md / MCP servers (near the existing `loadMcpServers` call, around `app.tsx:405`). Store in a state `skills`.
- Pass `skills` into:
  - The `tools` array at app.tsx:425 (main query) and app.tsx:753 (sub-agent context) — append `makeSkillTool(skills)` when `skills.length > 0`.
  - The `query()` call's options so `runLoop` forwards them to `buildSystemPrompt` (see §6).
  - The `SlashContext` constructed in `onSubmit` (app.tsx:562) and the sub-agent slash context (app.tsx:650).
- Wire `sendUserPrompt` in `SlashContext` to a callback that runs the same post-slash branch of `onSubmit` (from `buildUserContent` onward, app.tsx:604). Refactor that branch into a `runUserTurn(text)` helper to avoid duplicating the abort/probe/`query()` setup.

## 6. Pipe skills through the loop (`src/core/query.ts` + `src/core/loop.ts`)

- Add `skills?: Skill[]` to `QueryOptions` in `query.ts` (next to `claudeMdFiles`) and to `LoopArgs` in `loop.ts:25-51`.
- Forward into `buildSystemPrompt({ …, skills })` at loop.ts:72.
- Sub-agents (`runSubagent`, loop.ts:293): pass the parent's skill list and a freshly-built `makeSkillTool(skills)` in `subTools` so sub-agents can invoke skills too. Same reasoning as parent-tool parity.

## 7. Files to modify / create

**New**

- `src/skills/types.ts`
- `src/skills/loader.ts`
- `src/skills/render.ts`
- `src/skills/loader.test.ts`
- `src/skills/render.test.ts`
- `src/tools/builtin/skill.ts`
- `src/tools/builtin/skill.test.ts`

**Modified**

- `src/prompts/system.ts` — add `buildSkillsGuidance`, thread `skills` through `SystemPromptArgs`
- `src/tui/slash.tsx` — `/skills` command, `Skill` to `SlashContext`, skill-name fallback, popup integration
- `src/tui/app.tsx` — `loadSkills` call, thread through tools/query/slash context, `runUserTurn` refactor for the slash fallback path
- `src/core/query.ts` — `skills` field on `QueryOptions`, forward to loop
- `src/core/loop.ts` — `skills` in `LoopArgs`, pass to `buildSystemPrompt` and `runSubagent`
- `package.json` — add `gray-matter` dep

**Existing utilities reused**

- `tool()` helper at `src/tools/helper.ts:21` — for the Skill tool
- `findProjectRoot` pattern at `src/mcp/config.ts:97` — to anchor project-scoped discovery (lift or duplicate)
- `loadMcpServers` layering pattern at `src/mcp/config.ts:45` — model for `loadSkills`
- `ToolRegistry.registerAll` at `src/tools/registry.ts` — already accepts the Skill tool as just another `Tool`

## 8. Out of scope (deferred to v2)

- Plugin skills (`~/.claude/plugins/cache/…`) and the standard `~/.claude/skills/` directory.
- `` !`shell` `` prefetch, positional `$0`/`$1`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_SESSION_ID}`.
- Frontmatter fields `allowed-tools`, `model`, `effort`, `paths`, `hooks`, `context: fork`, `agent`.
- Hot-reload (`/skills reload`). Skills are loaded once per session.

## 9. Verification

**Unit / vitest** — `npm test`

1. `src/skills/loader.test.ts`
   - Project + user discovery, project precedence on collision, malformed YAML skipped, missing frontmatter accepted.
2. `src/skills/render.test.ts`
   - `$ARGUMENTS` substitution (single, multiple, empty).
3. `src/tools/builtin/skill.test.ts`
   - Known skill → returns body with substitution.
   - Unknown skill → `isError: true` with hint listing known names.
   - `disable-model-invocation: true` skill → refused via the Skill tool.

**Typecheck** — `npm run typecheck`

**End-to-end (manual TUI)**

1. Create `./.claude/skills/hello/SKILL.md` in the repo:
   ```
   ---
   name: hello
   description: Greet the user warmly using $ARGUMENTS as their name.
   ---
   Greet the user named **$ARGUMENTS** with a brief, friendly message.
   ```
2. Run `npm run dev` and at the prompt:
   - Type `/skills` → expect the hello skill listed under "Project".
   - Type `/hello Dave` → assistant turn produces a greeting addressed to Dave; the user-prompt block in the transcript shows the rendered body wrapped in `<system-reminder>`.
   - Plain prompt "please greet me as Dave" → model auto-invokes the `Skill` tool with `skill_name: "hello"`, `args: "Dave"`, then produces the greeting. (Verify by watching the tool_use block in the TUI.)
3. Add `~/.lcode/skills/hello/SKILL.md` with a different body → restart lcode → confirm `/skills` shows only one `hello` and it points at the project one (project wins).
4. Add `disable-model-invocation: true` to the project skill → restart → confirm `/skills` still lists it, `/hello Dave` still works, but the "Available Skills" section in the system prompt no longer includes it (inspect via a temporary `console.log` in `buildSystemPrompt`, or by observing the model no longer auto-invokes for the plain prompt above).

**Regression**

- `/help`, `/clear`, `/mcp`, `/model`, `/compact` still behave identically (no skill named `help` etc. should ever shadow a built-in — the lookup in `maybeRunSlashCommand` already checks `COMMANDS` first).
- Sessions resumed via `--resume` reload skills fresh from disk (skills are not persisted in JSONL — only their _renderings_ land in history, which is correct).
