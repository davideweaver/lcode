# System Prompt Construction

This document describes how lcode assembles the system prompt that is sent to
the LLM on every turn. It covers the source files, the assembly order, and what
each section contributes.

## Source files

- `src/prompts/system.ts` — `buildSystemPrompt()` assembles the final string.
- `src/prompts/agents.ts` — loads `~/.lcode/settings.json` + the four
  user-configurable agent files (Persona/Human/Capabilities/Instructions).
- `src/prompts/claudemd.ts` — discovers and renders `CLAUDE.md` files.
- `src/core/loop.ts` — calls `buildSystemPrompt()` on each `runLoop()` invocation.
- `src/core/query.ts` — calls `loadAgentFiles()` and `loadClaudeMdFiles()`,
  then threads both into the loop.

## Call path

```
query()  ──►  loadAgentFiles()        ──►  AgentFiles
       │  ──►  loadClaudeMdFiles(cwd)  ──►  ClaudeMdFile[]
       │
       └──►  runLoop({ ..., agentFiles, claudeMdFiles })
                │
                └──►  buildSystemPrompt({ cwd, tools, customSystemPrompt,
                                          permissionMode, agentFiles,
                                          claudeMdFiles })
```

Important: **the system prompt is rebuilt on every `runLoop()` call**, not
cached across turns. `agentFiles` and `claudeMdFiles` are loaded once per
`query()` call (or passed in by the caller for cross-call reuse).

## Assembly order

`buildSystemPrompt()` joins these sections with `\n\n` in this exact order:

1. **`# Persona`** — agent identity (file or default).
2. **`# Human`** — who the agent is talking to (file or default).
3. **`# Capabilities`** — what the agent can do (file or default).
4. **`# Environment`** — cwd, platform, OS release, today's date.
5. **`# Tools`** — one-line description per registered tool, plus a fixed
   block of usage rules.
6. **`# Plan mode active`** *(conditional)* — only when
   `permissionMode === 'plan'`.
7. **`# Instructions`** — terseness / style rules (file or default).
8. **`# claudeMd`** *(conditional)* — only when one or more `CLAUDE.md`
   files were discovered.
9. **`# User instructions`** *(conditional)* — only when the caller passed a
   `customSystemPrompt` (the `systemPrompt` option on `query()`).

Empty / falsy sections are filtered out before the join.

## User-configurable sections (`~/.lcode/`)

Sections 1, 2, 3, and 7 each map to a markdown file in `~/.lcode/`. The
loader is `src/prompts/agents.ts`. Each section is independently controlled
by `~/.lcode/settings.json`:

```json
{
  "agentFiles": {
    "persona":      { "enabled": false, "file": "PERSONA.md" },
    "human":        { "enabled": false, "file": "HUMAN.md" },
    "capabilities": { "enabled": false, "file": "CAPABILITIES.md" },
    "instructions": { "enabled": false, "file": "INSTRUCTIONS.md" }
  }
}
```

Resolution rules per entry:
- `enabled: false` → use the hard-coded `DEFAULT_*` content for that section.
- `enabled: true`  → read `~/.lcode/<file>`. If the read fails or the trimmed
  content is empty, fall back to `DEFAULT_*` and warn.
- `file` is just a filename — paths are always relative to `~/.lcode/`.
- A missing settings.json → write the default skeleton, then proceed.
- Malformed settings.json → warn once, treat all four as disabled, do **not**
  overwrite the file.

Out of the box (all four entries `enabled: false`), the prompt renders the
defaults from `src/prompts/agents.ts`. To customize, drop a `.md` file into
`~/.lcode/` and flip the matching `enabled` to `true`.

### Defaults

`PERSONA` and `INSTRUCTIONS` defaults match lcode's pre-configurable behavior
byte-for-byte. `HUMAN` and `CAPABILITIES` are short placeholders intended to
be replaced.

```
DEFAULT_PERSONA:
You are lcode, a local coding assistant running on a small open-weight model.
You behave like Claude Code: you read and edit files, run shell commands, and
search the codebase to complete software engineering tasks. You are not Claude.
Be honest about that if asked.

DEFAULT_HUMAN:
You are working with a software engineer at a terminal. Address them directly
when you need clarification.

DEFAULT_CAPABILITIES:
You can read and edit files, run shell commands, search the codebase, and
call any MCP tools the user has configured. The exact tool list and rules are
in the Tools section below.

DEFAULT_INSTRUCTIONS:
- Be terse. State what you're doing in one short sentence before tool calls
  when useful.
- Don't narrate internal deliberation. Don't summarize what just happened —
  the user can see the tool results.
- When you reference code, cite as path:line so the user can navigate.
```

## Other sections

### `# Environment` (computed per turn)

```
# Environment
- Working directory: <cwd>
- Platform: <os.platform()> <os.release()>
- Date: <YYYY-MM-DD>
```

### `# Tools` (computed from registered tools)

The header is fixed:

```
# Tools
You have these tools. Use them deliberately.
```

Followed by one bullet per tool that survived `filterToolsForMode()`
(in plan mode, only `readOnly` tools are listed):

```
- **<name>** — <description, truncated to 160 chars>
```

The tool list is then followed by a fixed `Rules:` block covering:
- absolute paths for Read/Write/Edit
- Read-before-Edit/Write requirement
- `old_string` uniqueness for Edit
- when to prefer dedicated tools over Bash
- WebSearch vs. WebFetch
- "stop calling tools when done"

> Tool **schemas** are not in the system prompt — they are sent separately via
> the OpenAI `tools[]` field. The system prompt only contains *guidance about
> when to use each tool*.

### `# Plan mode active` (conditional)

```
# Plan mode active
You may only read and search. Do not Write, Edit, or run Bash. Produce a plan,
then stop.
```

This pairs with `filterToolsForMode()` in `loop.ts` which strips non-readOnly
tools from the registered tool list in plan mode.

### `# claudeMd` (conditional)

`loadClaudeMdFiles(cwd)` discovers files from three sources, in this order:

1. **User-level**: `~/.claude/CLAUDE.md` (applies to every project)
2. **Project root**: walks up from `cwd` looking for `.git`, then loads the
   `CLAUDE.md` at that root.
3. **Ancestor directories**: each `CLAUDE.md` between project root and `cwd`,
   so more specific directories override more general ones.

Each file's content has `@path/to/file.md` imports recursively expanded
(up to depth 5; `~/` and absolute paths supported).

The rendered section looks like:

```
# claudeMd
Codebase and user instructions are shown below. Be sure to adhere to these
instructions. IMPORTANT: These instructions OVERRIDE any default behavior and
you MUST follow them exactly as written.

Contents of <abs path> (<source label>):

<file content>

…

NOTE: The file(s) above (<paths>) are already loaded into your context. Do not
call Read on them again — you already have their full contents. When the user
asks about the project, answer directly from the content above.
```

`<source label>` is one of:
- `user instructions, applied to all projects`
- `project instructions, checked into the codebase`
- `directory-specific instructions`

### `# User instructions` (conditional)

```
# User instructions
<customSystemPrompt, trimmed>
```

This is the `systemPrompt` option of `query()` — supplied by SDK consumers, not
by users editing a file.

## Worked example

For a fresh install with no `~/.lcode/*.md` files present, no plan mode, and
no `customSystemPrompt`, the final prompt looks roughly like:

```
# Persona
You are lcode, a local coding assistant…

# Human
You are working with a software engineer at a terminal…

# Capabilities
You can read and edit files, run shell commands, search the codebase…

# Environment
- Working directory: /Users/.../lcode
- Platform: darwin 25.2.0
- Date: 2026-05-09

# Tools
You have these tools. Use them deliberately.
- **Bash** — …
- **Read** — …
…

Rules:
- File paths for Read/Write/Edit must be **absolute**…
…

# Instructions
- Be terse…
…

# claudeMd
Codebase and user instructions are shown below…
…
```
