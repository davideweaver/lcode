/**
 * Manual: prints the system prompt that lcode would build for `cwd=lcode`,
 * so we can verify CLAUDE.md actually lands in the prompt.
 *
 * Run with: npx tsx tests/inspect-prompt.ts
 */
import { loadClaudeMdFiles } from '../src/prompts/claudemd.js';
import { buildSystemPrompt } from '../src/prompts/system.js';
import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';

async function main() {
  const cwd = process.cwd();
  const files = await loadClaudeMdFiles(cwd);
  console.log(`Loaded ${files.length} CLAUDE.md file(s):`);
  for (const f of files) {
    console.log(`  - ${f.source}: ${f.path} (${f.content.length} chars)`);
  }
  console.log('\n========== FULL SYSTEM PROMPT ==========\n');
  const prompt = buildSystemPrompt({
    cwd,
    tools: BUILTIN_TOOLS,
    claudeMdFiles: files,
  });
  console.log(prompt);
  console.log('\n========== END (' + prompt.length + ' chars) ==========');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
