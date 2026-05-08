/**
 * Debug: capture raw delta.content from gemma4 for the leaking prompt,
 * so we can see exactly what the filter is up against.
 *
 * Run: npx tsx tests/debug-stream.ts
 */
import { loadConfig } from '../src/config.js';

async function main() {
  const config = loadConfig();
  const url = `${config.llmUrl.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;
  const body = {
    model: config.model,
    stream: true,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: true },
    messages: [
      { role: 'user', content: 'what llm provider do we support?' },
    ],
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    console.error('HTTP', res.status, await res.text().catch(() => ''));
    process.exit(1);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let allContent = '';
  let allReasoning = '';
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
        if (delta?.content) {
          allContent += delta.content;
        }
        if (delta?.reasoning_content) {
          allReasoning += delta.reasoning_content;
        }
      } catch {
        // ignore
      }
    }
  }
  console.log('===== content =====');
  console.log(JSON.stringify(allContent));
  console.log('\n===== reasoning =====');
  console.log(JSON.stringify(allReasoning).slice(0, 1000));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
