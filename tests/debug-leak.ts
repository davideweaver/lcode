/**
 * Reproduces Dave's leak: full lcode pipeline (system prompt + tools +
 * multi-turn) against gemma4. Logs raw delta.content from each LLM turn
 * so we can see exactly what's leaking.
 *
 * Run: npx tsx tests/debug-leak.ts
 */
import { loadConfig } from '../src/config.js';
import { anthropicToOpenAI, toOpenAITools } from '../src/core/llm.js';
import type { AnthropicMessage } from '../src/core/messages.js';
import { buildSystemPrompt } from '../src/prompts/system.js';
import { loadClaudeMdFiles } from '../src/prompts/claudemd.js';
import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';

async function streamRaw(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
}): Promise<{ content: string; reasoning: string }> {
  const url = `${args.baseUrl}/v1/chat/completions`;
  const body = {
    model: args.model,
    stream: true,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: true },
    messages: anthropicToOpenAI(args.systemPrompt, args.messages),
    tools: toOpenAITools(BUILTIN_TOOLS),
    tool_choice: 'auto',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trimEnd();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const chunk = JSON.parse(data);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) content += delta.content;
        if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      } catch {
        /* ignore */
      }
    }
  }
  return { content, reasoning };
}

async function main() {
  const config = loadConfig();
  const baseUrl = config.llmUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const cwd = process.cwd();
  const claudeMdFiles = await loadClaudeMdFiles(cwd);
  const systemPrompt = buildSystemPrompt({
    cwd,
    tools: BUILTIN_TOOLS,
    claudeMdFiles,
  });

  const messages: AnthropicMessage[] = [];
  // Simulate the conversation: user prompt → assistant tool_use → tool_result
  // → assistant final text. Print raw content from BOTH turns.

  // Turn 1: user prompt
  console.log('========== TURN 1 (initial) ==========');
  const t1 = await streamRaw({
    baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what llm provider do we support?' }] },
    ],
  });
  console.log('content:', JSON.stringify(t1.content));
  console.log('reasoning (first 500):', JSON.stringify(t1.reasoning.slice(0, 500)));
  console.log();

  // Build turn 2 history if turn 1 had tool calls in content (rare for gemma4)
  // but we'll simulate the typical Glob flow Dave is hitting:
  console.log('========== TURN 2 (after fake Glob result) ==========');
  const t2messages: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'what llm provider do we support?' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: t1.content },
        {
          type: 'tool_use',
          id: 'call_glob_1',
          name: 'Glob',
          input: { pattern: 'src/**/*.ts' },
        },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_glob_1',
          content:
            '/Users/dweaver/Projects/ai/xerro-agent/projects/lcode/src/core/llm.ts\n' +
            '/Users/dweaver/Projects/ai/xerro-agent/projects/lcode/src/core/harmony-filter.ts\n' +
            '/Users/dweaver/Projects/ai/xerro-agent/projects/lcode/src/tui/banner.ts',
        },
      ],
    },
  ];
  const t2 = await streamRaw({
    baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages: t2messages,
  });
  console.log('content:', JSON.stringify(t2.content));
  console.log('reasoning (first 500):', JSON.stringify(t2.reasoning.slice(0, 500)));
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
