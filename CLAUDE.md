# lcode

Local Claude Code replica: a Claude-Agent-SDK-shaped harness that runs on llama.cpp.

## Project Overview

`lc` is a terminal-based agentic interface designed to mimic the experience of Claude Code, but optimized for local LLM execution via OpenAI-compatible endpoints (like `llama.cpp`). It provides a rich TUI for interacting with your local models, allowing them to use tools to interact with your filesystem and shell.

## Tech Stack

- **Runtime**: Node.js (>=20)
- **Language**: TypeScript
- **TUI**: [Ink](https://github.com/vadimdemedes/ink) (React-based CLI)
- **LLM Interface**: OpenAI-compatible streaming API
- **Schema Validation**: [Zod](https://zod.dev/)
- **Testing**: [Vite Vitest](https://vitest.dev/)

## Getting Started

### Prerequisites

- Node.js >= 20
- A running OpenAI-compatible LLM server (e.g., `llama.cpp` server)

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set up your environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your LLM configuration
   ```

### Development

- **Run in dev mode**:
  ```bash
  npm run dev
  ```
- **Build the project**:
  ```bash
  npm run build
  ```
- **Run tests**:
  ```bash
  npm test
  ```
- **Typecheck**:
  ```bash
  npm run typecheck
  ```

## Commands

The main entry point is the `lc` binary.

- `lc chat`: Opens the interactive TUI (default).
  - `--resume <sessionId>`: Resume an existing session by ID.
- `lc health`: Probes the configured LLM endpoint to ensure connectivity and compatibility.

## Architecture

- `bin/lc.ts`: CLI entry point using `commander`.
- `src/core/`: Core logic for the agent loop, session management, and LLM interaction.
- `src/tu/`: React components for the Ink-based TUI.
- `src/tools/`: Implementation of agent tools (bash, grep, glob, edit, write, read).
- `src/config.ts`: Configuration loading and management.

## Tooling

The agent has access to several built-in tools:
- `bash`: Execute shell commands.
- `grep`: Search file contents.
- `glob`: List files matching patterns.
- `edit`: Replace text in files.
- `write`: Write content to files.
- `read`: Read file contents.

## Coding Standards

- Use TypeScript for all source files.
- Follow the existing patterns for tool definitions using Zod schemas.
- Maintain the separation between core logic (`src/core`) and UI logic (`src/tu`).
- Ensure all new tools are registered in `src/tools/registry.ts`.