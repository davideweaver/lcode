import type { LcodeConfig } from './config.js';
import { query } from './core/query.js';
import type { ContentBlock, SDKMessage } from './core/messages.js';
import { defaultAgentFiles, loadAgentFiles } from './prompts/agents.js';
import { loadClaudeMdFiles } from './prompts/claudemd.js';
import { loadMcpServers } from './mcp/config.js';
import { loadDisabledServers } from './mcp/disabled.js';
import { McpManager } from './mcp/manager.js';

export interface RunHeadlessArgs {
  prompt: string;
  config: LcodeConfig;
  model?: string;
  resume?: string;
  skipAgentFiles?: boolean;
  skipMcp?: boolean;
  overrideSystemPrompt?: string;
  enableThinking?: boolean;
}

export async function runHeadless(args: RunHeadlessArgs): Promise<number> {
  const t0 = performance.now();
  const mark = (label: string) => {
    const ms = Math.round(performance.now() - t0);
    process.stderr.write(`[+${ms}ms] ${label}\n`);
  };

  const cwd = process.cwd();
  const model = args.model ?? args.config.model;

  process.stderr.write(`lcode → ${args.config.llmUrl} model=${model}\n`);

  // Run setup tasks concurrently — same shape the TUI uses (separate
  // useEffects firing in parallel at mount). Each await fires its own
  // mark so the slowest phase is visible regardless of completion order.
  const agentFilesPromise = (async () => {
    const r = args.skipAgentFiles ? defaultAgentFiles() : await loadAgentFiles();
    mark('agent files loaded');
    return r;
  })();
  const claudeMdPromise = (async () => {
    const r = await loadClaudeMdFiles(cwd);
    mark('claude.md loaded');
    return r;
  })();
  const mcpPromise = (async () => {
    if (args.skipMcp) {
      mark('mcp skipped');
      return new McpManager([]);
    }
    const [entries, disabled] = await Promise.all([
      loadMcpServers(cwd),
      loadDisabledServers(),
    ]);
    const manager = new McpManager(entries, { disabled });
    await manager.start();
    mark('mcp manager started');
    return manager;
  })();

  const [agentFiles, claudeMdFiles, mcpManager] = await Promise.all([
    agentFilesPromise,
    claudeMdPromise,
    mcpPromise,
  ]);

  const abortController = new AbortController();
  const onSigint = () => {
    process.stderr.write('\n[sigint] aborting...\n');
    abortController.abort();
  };
  process.on('SIGINT', onSigint);

  let exitCode = 1;
  let sawFirstToken = false;
  let stdoutEndsWithNewline = true;
  const writeStdout = (text: string) => {
    if (text.length === 0) return;
    process.stdout.write(text);
    stdoutEndsWithNewline = text.endsWith('\n');
  };

  mark('query started');
  try {
    const stream: AsyncGenerator<SDKMessage> = query({
      prompt: args.prompt,
      cwd,
      model,
      abortController,
      resume: args.resume,
      includePartialMessages: true,
      config: args.config,
      claudeMdFiles,
      agentFiles,
      mcpManager,
      overrideSystemPrompt: args.overrideSystemPrompt,
      enableThinking: args.enableThinking,
    });

    for await (const msg of stream) {
      switch (msg.type) {
        case 'partial_assistant': {
          if (!sawFirstToken) {
            sawFirstToken = true;
            mark('first LLM token');
          }
          if (msg.event.kind === 'text_delta') writeStdout(msg.event.text);
          else if (msg.event.kind === 'thinking_start') mark('thinking start');
          else if (msg.event.kind === 'thinking_stop') mark('thinking stop');
          break;
        }
        case 'assistant': {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              mark(`tool: ${block.name}(${block.id.slice(-6)})`);
            }
          }
          break;
        }
        case 'user': {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content as ContentBlock[]) {
              if (block.type === 'tool_result') {
                const id = block.tool_use_id.slice(-6);
                mark(`tool_result: ${id} ${block.is_error ? 'err' : 'ok'}`);
              }
            }
          }
          break;
        }
        case 'compaction': {
          mark(`compaction: ${msg.subtype}`);
          break;
        }
        case 'result': {
          mark(`turn end: subtype=${msg.subtype} turns=${msg.num_turns}`);
          if (msg.error) process.stderr.write(`error: ${msg.error}\n`);
          exitCode = msg.subtype === 'success' ? 0 : 1;
          break;
        }
        case 'system':
        case 'subagent_progress':
          break;
      }
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${m}\n`);
    exitCode = 1;
  } finally {
    process.off('SIGINT', onSigint);
    if (!stdoutEndsWithNewline) process.stdout.write('\n');
    await mcpManager.close();
  }
  return exitCode;
}
