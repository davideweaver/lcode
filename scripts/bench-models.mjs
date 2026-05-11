#!/usr/bin/env node
// Compares two OpenAI-compatible chat endpoints on the same prompts.
// Measures TTFT, total time, and tokens/sec across cold (first run) and
// warm (subsequent runs) KV-cache states. Saves per-prompt responses to
// disk and writes a markdown summary.
//
// Usage: node scripts/bench-models.mjs [--runs N]

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const SERVERS = [
  {
    name: 'omlx',
    label: 'MLX (omlx server)',
    url: 'http://llm.appkit.local:8000/v1/chat/completions',
    model: 'gemma-4-26b-a4b-it-4bit',
    apiKey: 'n983y&f@89vy34nvy89234cfv',
    // Pattern fed to ssh pgrep on the llm box for RSS sampling.
    procPattern: 'omlx',
  },
  {
    name: 'llamacpp',
    label: 'llama.cpp',
    url: 'http://llm.appkit.local:9000/v1/chat/completions',
    model: 'gemma-4-26B-A4B-it-UD-Q4_K_M.gguf',
    apiKey: null,
    procPattern: 'llama-server.*gemma-4',
  },
];

// Token budgets are generous so Gemma 4's thinking channel (enabled by
// default in llama.cpp) has room to finish reasoning and produce a final
// answer in `content`. With tight budgets, llama.cpp burns the whole
// budget on `reasoning_content` and emits nothing in `content` —
// unrepresentative of real lcode usage.
const PROMPTS = [
  {
    name: 'tiny',
    maxTokens: 1024,
    messages: [{ role: 'user', content: 'Say only the word READY.' }],
  },
  {
    name: 'qa-short',
    maxTokens: 2048,
    messages: [{ role: 'user', content: 'In two sentences, explain what tree-shaking is in JavaScript bundlers.' }],
  },
  {
    name: 'code-explain',
    maxTokens: 2048,
    messages: [{
      role: 'user',
      content:
        'Explain in 2-3 sentences what this code does, and identify one bug:\n\n' +
        'async function* asyncGen() {\n' +
        '  for (let i = 0; i < 3; i++) {\n' +
        '    yield await fetch(`/api/item/${i}`).then(r => r.json());\n' +
        '  }\n' +
        '}',
    }],
  },
  {
    name: 'code-gen',
    maxTokens: 3072,
    messages: [{
      role: 'user',
      content:
        'Write a TypeScript function `debounceAsync<T>(fn: (...args: any[]) => Promise<T>, ms: number): (...args: any[]) => Promise<T>` ' +
        'with latest-call-wins semantics: while an in-flight call is pending, new calls should NOT trigger another invocation until the timer elapses, ' +
        'and the returned promise of all coalesced calls should resolve with the result of the eventual single invocation. ' +
        'Include a small inline example. Return ONLY the code, no commentary.',
    }],
  },
  {
    name: 'long-summary',
    maxTokens: 1536,
    messages: [{
      role: 'user',
      content:
        'Summarize this text in exactly 3 bullets:\n\n' +
        Array(40).fill(
          'The fundamental theorem of calculus connects differentiation and integration. ' +
          'In its first form, it states that if f is continuous on [a, b] and F is the function ' +
          'defined by F(x) = integral from a to x of f(t) dt, then F is differentiable and F\'(x) = f(x). '
        ).join(''),
    }],
  },
];

const RUNS_PER_PROMPT = (() => {
  const idx = process.argv.indexOf('--runs');
  if (idx >= 0 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  return 3;
})();

const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
const OUT_DIR = resolve(process.cwd(), 'bench-results', TIMESTAMP);
mkdirSync(OUT_DIR, { recursive: true });

function fmt(n, places = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toFixed(places);
}

async function sampleRss(server) {
  try {
    const { stdout } = await execFileAsync('ssh', [
      'dweaver@llm',
      `pgrep -fa "${server.procPattern}" | grep -v pgrep | awk '{print $1}' | head -1 | xargs -I{} ps -o rss= -p {}`,
    ], { timeout: 5000 });
    const rssKb = Number(stdout.trim());
    if (!Number.isFinite(rssKb) || rssKb <= 0) return null;
    return rssKb / 1024; // MB
  } catch {
    return null;
  }
}

async function runOnce(server, prompt) {
  const headers = { 'Content-Type': 'application/json' };
  if (server.apiKey) headers['Authorization'] = `Bearer ${server.apiKey}`;
  const body = {
    model: server.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: prompt.maxTokens,
    temperature: 0.2,
    messages: prompt.messages,
  };
  const t0 = performance.now();
  let ttftMs = null;
  let ttfAnswerMs = null;
  let outputText = '';
  let thinkingText = '';
  let outTokens = 0;
  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      // Gemma 4 on llama.cpp emits thinking through `reasoning_content`
      // before the final `content`. Treat the first token of either
      // channel as the start-of-response signal (TTFT), and track when
      // the actual answer begins separately (ttfAnswerMs).
      if (delta?.reasoning_content) {
        if (ttftMs === null) ttftMs = performance.now() - t0;
        thinkingText += delta.reasoning_content;
      }
      if (delta?.content) {
        if (ttftMs === null) ttftMs = performance.now() - t0;
        if (ttfAnswerMs === null) ttfAnswerMs = performance.now() - t0;
        outputText += delta.content;
      }
      if (chunk.usage?.completion_tokens) outTokens = chunk.usage.completion_tokens;
    }
  }
  const totalMs = performance.now() - t0;
  // Fallback if server didn't emit usage: rough char-based estimate over
  // both channels combined (matches what the server billed against the
  // KV cache).
  if (outTokens === 0) {
    const combined = thinkingText.length + outputText.length;
    if (combined > 0) outTokens = Math.round(combined / 3.8);
  }
  const genMs = ttftMs != null ? Math.max(1, totalMs - ttftMs) : totalMs;
  const tokPerSec = outTokens > 0 ? (outTokens / (genMs / 1000)) : null;
  return { ttftMs, ttfAnswerMs, totalMs, outTokens, tokPerSec, outputText, thinkingText };
}

async function benchServer(server) {
  console.log(`\n=== ${server.label} ===`);
  const rssBefore = await sampleRss(server);
  console.log(`  rss before: ${fmt(rssBefore, 0)} MB`);
  const results = [];
  for (const prompt of PROMPTS) {
    const runs = [];
    for (let i = 0; i < RUNS_PER_PROMPT; i++) {
      try {
        const r = await runOnce(server, prompt);
        runs.push(r);
        console.log(`  ${prompt.name} run${i + 1}: TTFT=${fmt(r.ttftMs, 0)}ms TTanswer=${fmt(r.ttfAnswerMs, 0)}ms total=${fmt(r.totalMs, 0)}ms out=${r.outTokens}tok ${fmt(r.tokPerSec, 1)}tok/s`);
      } catch (e) {
        console.error(`  ${prompt.name} run${i + 1}: ERROR ${e.message}`);
        runs.push({ error: e.message });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    const best = runs.find((r) => r.outputText) ?? runs.find((r) => r.thinkingText);
    if (best) {
      let body = '';
      if (best.thinkingText) body += `<thinking>\n${best.thinkingText}\n</thinking>\n\n`;
      body += best.outputText || '(no content emitted — model spent all budget thinking)';
      await writeFile(
        resolve(OUT_DIR, `${server.name}_${prompt.name}.txt`),
        body,
      );
    }
    results.push({ prompt: prompt.name, runs });
  }
  const rssAfter = await sampleRss(server);
  console.log(`  rss after: ${fmt(rssAfter, 0)} MB`);
  return { rssBefore, rssAfter, results };
}

function summarize(server, byPrompt) {
  let md = `\n## ${server.label}\n\n`;
  md += `Model: \`${server.model}\`  \nEndpoint: \`${server.url}\`\n\n`;
  md += `| prompt | cold TTFT | warm TTFT | TT-answer (warm) | warm total | out tok | tok/s (warm) |\n`;
  md += `|--------|-----------|-----------|------------------|------------|---------|---------------|\n`;
  for (const rec of byPrompt) {
    const valid = rec.runs.filter((r) => !r.error);
    if (valid.length === 0) {
      md += `| ${rec.prompt} | ERROR | — | — | — | — | — |\n`;
      continue;
    }
    const cold = valid[0];
    const warm = valid.slice(1);
    const avg = (key) => warm.length ? warm.reduce((s, r) => s + (r[key] ?? 0), 0) / warm.length : null;
    md += `| ${rec.prompt} | ${fmt(cold.ttftMs, 0)}ms | ${fmt(avg('ttftMs'), 0)}ms | ${fmt(avg('ttfAnswerMs'), 0)}ms | ${fmt(avg('totalMs'), 0)}ms | ${fmt(avg('outTokens') ?? cold.outTokens, 0)} | ${fmt(avg('tokPerSec'), 1)} |\n`;
  }
  return md;
}

async function main() {
  const summary = {};
  for (const server of SERVERS) {
    summary[server.name] = await benchServer(server);
  }
  let md = `# Gemma 4 benchmark — ${new Date().toISOString()}\n\n`;
  md += `Runs per prompt: ${RUNS_PER_PROMPT} (first is cold KV cache, rest are warm)\n\n`;
  md += `## Resident memory (server-side)\n\n`;
  md += `| server | before | after |\n|--------|--------|-------|\n`;
  for (const server of SERVERS) {
    const s = summary[server.name];
    md += `| ${server.label} | ${fmt(s.rssBefore, 0)} MB | ${fmt(s.rssAfter, 0)} MB |\n`;
  }
  for (const server of SERVERS) {
    md += summarize(server, summary[server.name].results);
  }
  md += `\n## Files\n\nPer-prompt responses saved alongside this file for side-by-side quality review.\n`;
  await writeFile(resolve(OUT_DIR, 'summary.md'), md);
  console.log(`\n${md}`);
  console.log(`\nResults: ${OUT_DIR}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
