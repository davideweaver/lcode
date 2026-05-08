/**
 * Manual smoke script: runs `query()` against the configured local LLM.
 * Run with: npx tsx tests/smoke-query.ts
 */
import { query } from '../src/index.js';

async function main() {
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 30_000);
  try {
    let readCount = 0;
    let thinkingCount = 0;
    for await (const msg of query({
      prompt: 'what llm provider do we support?',
      cwd: process.cwd(),
      abortController: ctl,
      maxTurns: 4,
      includePartialMessages: false,
    })) {
      if (msg.type === 'partial_assistant') continue;
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'thinking') {
            thinkingCount++;
            console.log(`>>> thinking (${block.thinking.length} chars): ${block.thinking.slice(0, 200)}…`);
          }
          if (block.type === 'tool_use' && block.name === 'Read') {
            readCount++;
            const fp = (block.input as { file_path?: string }).file_path;
            console.log(`>>> tool_use Read ${fp}`);
          }
          if (block.type === 'text') {
            console.log(`>>> assistant text: ${block.text.slice(0, 300)}`);
          }
        }
      }
      if (msg.type === 'result') {
        console.log(
          `>>> result subtype=${msg.subtype} turns=${msg.num_turns} ` +
            `read_calls=${readCount} thinking_blocks=${thinkingCount}`,
        );
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}

main().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
