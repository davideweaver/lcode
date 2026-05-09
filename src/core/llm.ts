import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AnthropicMessage,
  ContentBlock,
  PartialAssistantEvent,
  Usage,
} from './messages.js';
import type { Tool } from '../tools/types.js';
import { ThinkingStreamParser } from './thinking-parser.js';
import { HarmonyNoiseFilter } from './harmony-filter.js';

export interface LlmStreamArgs {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: AnthropicMessage[];
  tools: Tool[];
  signal: AbortSignal;
  temperature?: number;
}

export interface LlmFinalMessage {
  content: ContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  usage?: Usage;
}

interface OpenAIToolCallAccum {
  index: number;
  id: string;
  name: string;
  argumentsRaw: string;
}

interface OpenAIDelta {
  content?: string;
  /**
   * llama.cpp / OpenAI-o1-style "reasoning" channel. When the server splits
   * thinking out of `content` (e.g. for Qwen3 with `enable_thinking`), it
   * arrives here. Treated as a thinking block.
   */
  reasoning_content?: string;
  role?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
}

interface OpenAIChoice {
  index: number;
  delta?: OpenAIDelta;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'function_call' | null;
}

interface OpenAIChunk {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Stream a completion from an OpenAI-compatible endpoint (llama.cpp).
 * Yields PartialAssistantEvents as deltas arrive, returns the final
 * aggregated assistant message via the generator's `return` value.
 */
export async function* streamLlm(
  args: LlmStreamArgs,
): AsyncGenerator<PartialAssistantEvent, LlmFinalMessage, void> {
  const url = `${args.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const body = {
    model: args.model,
    stream: true,
    temperature: args.temperature ?? 0.2,
    messages: anthropicToOpenAI(args.systemPrompt, args.messages),
    tools: args.tools.length > 0 ? toOpenAITools(args.tools) : undefined,
    tool_choice: args.tools.length > 0 ? 'auto' : undefined,
    // Hint to llama.cpp / Qwen3-style chat templates: produce reasoning when
    // the model supports it. Servers that don't recognize this field ignore it.
    chat_template_kwargs: { enable_thinking: true },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: args.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  let textAccum = '';
  const thinkingBlocks: string[] = [];
  let currentThinking: string | null = null;
  let reasoningChannelOpen = false;
  const noise = new HarmonyNoiseFilter();
  const parser = new ThinkingStreamParser();
  const toolCalls = new Map<number, OpenAIToolCallAccum>();
  let stopReason: LlmFinalMessage['stop_reason'] = null;
  let usage: Usage | undefined;

  for await (const chunk of parseSseChunks(res.body, args.signal)) {
    const choice = chunk.choices?.[0];
    if (chunk.usage) {
      usage = {
        input_tokens: chunk.usage.prompt_tokens ?? 0,
        output_tokens: chunk.usage.completion_tokens ?? 0,
      };
    }
    if (!choice) continue;

    const delta = choice.delta;

    // 1. Server-side reasoning channel (llama.cpp / o1 style). Open a
    //    thinking block on first reasoning_content, append deltas, close
    //    when content (or stream end) signals reasoning is finished.
    if (delta?.reasoning_content) {
      if (!reasoningChannelOpen) {
        reasoningChannelOpen = true;
        currentThinking = '';
        yield { kind: 'thinking_start' };
      }
      currentThinking = (currentThinking ?? '') + delta.reasoning_content;
      yield { kind: 'thinking_delta', text: delta.reasoning_content };
    }

    // 2. content arriving while reasoning channel is open ⇒ reasoning ended.
    if (delta?.content && reasoningChannelOpen) {
      if (currentThinking !== null) thinkingBlocks.push(currentThinking);
      currentThinking = null;
      reasoningChannelOpen = false;
      yield { kind: 'thinking_stop' };
    }

    // 3. content channel — first strip Harmony channel markers (e.g.
    //    `<|channel|>thought<|message|>`) that some quants leak as plain
    //    text, then feed through the inline <think> parser as a fallback
    //    for models that emit reasoning tags directly in content.
    if (delta?.content) {
      const cleaned = noise.feed(delta.content);
      if (cleaned) {
        for (const ev of parser.feed(cleaned)) {
          if (ev.kind === 'text_delta') {
            textAccum += ev.text;
            yield ev;
          } else if (ev.kind === 'thinking_start') {
            currentThinking = '';
            yield ev;
          } else if (ev.kind === 'thinking_delta') {
            if (currentThinking !== null) currentThinking += ev.text;
            yield ev;
          } else if (ev.kind === 'thinking_stop') {
            if (currentThinking !== null) thinkingBlocks.push(currentThinking);
            currentThinking = null;
            yield ev;
          }
        }
      }
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        let acc = toolCalls.get(tc.index);
        if (!acc) {
          acc = {
            index: tc.index,
            id: tc.id ?? `call_${tc.index}`,
            name: tc.function?.name ?? '',
            argumentsRaw: '',
          };
          toolCalls.set(tc.index, acc);
          yield { kind: 'tool_use_start', id: acc.id, name: acc.name };
        } else if (tc.id && !acc.id.startsWith('call_')) {
          // late id arrival, prefer it
          acc.id = tc.id;
        }
        if (tc.function?.name && !acc.name) {
          acc.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          acc.argumentsRaw += tc.function.arguments;
          yield {
            kind: 'tool_use_input_delta',
            id: acc.id,
            partialJson: tc.function.arguments,
          };
        }
      }
    }
    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason);
    }
  }

  for (const acc of toolCalls.values()) {
    yield { kind: 'tool_use_stop', id: acc.id };
  }

  // If the stream ended while reasoning_content was still flowing (no
  // content ever arrived to close it), finalize the block now.
  if (reasoningChannelOpen) {
    if (currentThinking !== null) thinkingBlocks.push(currentThinking);
    currentThinking = null;
    reasoningChannelOpen = false;
    yield { kind: 'thinking_stop' };
  }

  // Flush the harmony filter's hold-back tail through the think parser.
  const tail = noise.flush();
  if (tail) {
    for (const ev of parser.feed(tail)) {
      if (ev.kind === 'text_delta') {
        textAccum += ev.text;
      } else if (ev.kind === 'thinking_delta') {
        if (currentThinking !== null) currentThinking += ev.text;
      } else if (ev.kind === 'thinking_stop') {
        if (currentThinking !== null) thinkingBlocks.push(currentThinking);
        currentThinking = null;
      }
      yield ev;
    }
  }

  // End-of-stream flush for the inline <think> parser (in case content
  // ended mid-tag).
  for (const ev of parser.flush()) {
    if (ev.kind === 'text_delta') {
      textAccum += ev.text;
    } else if (ev.kind === 'thinking_delta') {
      if (currentThinking !== null) currentThinking += ev.text;
    } else if (ev.kind === 'thinking_stop') {
      if (currentThinking !== null) thinkingBlocks.push(currentThinking);
      currentThinking = null;
    }
    yield ev;
  }

  const content: ContentBlock[] = [];
  // Thinking goes first — Qwen-style models reason then respond, and
  // putting these blocks first preserves that order in the assistant message.
  for (const t of thinkingBlocks) content.push({ type: 'thinking', thinking: t });
  if (textAccum) content.push({ type: 'text', text: textAccum });
  for (const acc of [...toolCalls.values()].sort((a, b) => a.index - b.index)) {
    let parsed: Record<string, unknown> = {};
    if (acc.argumentsRaw.trim()) {
      try {
        parsed = JSON.parse(acc.argumentsRaw);
      } catch {
        parsed = { __raw: acc.argumentsRaw, __parse_error: true };
      }
    }
    content.push({ type: 'tool_use', id: acc.id, name: acc.name, input: parsed });
  }

  return { content, stop_reason: stopReason, usage };
}

/**
 * One-shot non-streaming completion. Drives streamLlm with no tools and
 * returns the concatenated assistant text. Used by tools (e.g. WebFetch)
 * that need a side-channel LLM call without re-entering the agent loop.
 */
export async function runCompletion(args: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
  temperature?: number;
}): Promise<string> {
  const messages: AnthropicMessage[] = [
    { role: 'user', content: [{ type: 'text', text: args.userPrompt }] },
  ];
  const gen = streamLlm({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    model: args.model,
    systemPrompt: args.systemPrompt,
    messages,
    tools: [],
    signal: args.signal,
    temperature: args.temperature,
  });
  let final: LlmFinalMessage | undefined;
  while (true) {
    const next = await gen.next();
    if (next.done) {
      final = next.value;
      break;
    }
  }
  return final.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function mapFinishReason(reason: string): LlmFinalMessage['stop_reason'] {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    default:
      return null;
  }
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export function anthropicToOpenAI(
  systemPrompt: string,
  messages: AnthropicMessage[],
): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (msg.role === 'assistant') {
      // Round-trip thinking back to the model in its native <think> form so
      // it can rebuild reasoning context — matches Anthropic's persistence
      // behavior for thinking blocks.
      const parts: string[] = [];
      for (const block of msg.content) {
        if (block.type === 'thinking') {
          parts.push(`<think>${block.thinking}</think>`);
        } else if (block.type === 'text') {
          parts.push(block.text);
        }
      }
      const text = parts.join('');
      const toolCalls = msg.content
        .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => b.type === 'tool_use')
        .map((b) => ({
          id: b.id,
          type: 'function' as const,
          function: { name: b.name, arguments: JSON.stringify(b.input) },
        }));
      const out_msg: OpenAIMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length > 0) out_msg.tool_calls = toolCalls;
      out.push(out_msg);
    } else {
      // role: 'user' — emit tool_result blocks first (in order), then any text
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          const content = typeof block.content === 'string'
            ? block.content
            : block.content.map((c) => c.text).join('');
          out.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content,
          });
        }
      }
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

export function toOpenAITools(tools: Tool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: sanitizeSchemaForLlm(
        t.inputJsonSchema ?? zodToJsonSchema(t.inputSchema, { target: 'openApi3' }),
      ),
    },
  }));
}

/**
 * Normalize JSON Schema shapes that local model chat templates can't render.
 *
 * Concretely: many MCP servers return `"type": ["string", "null"]` (a valid
 * JSON-Schema 2020-12 form), but llama.cpp's bundled Gemma chat template
 * does `value['type'] | upper`, which assumes a scalar string and crashes
 * with "Unknown filter 'upper' for type Array". We collapse the array to
 * a single scalar (preferring the first non-null entry) and set
 * `nullable: true` if `null` was one of the options.
 *
 * We recurse into `properties`, `items`, and the combinator keywords so
 * nested schemas are normalized too. Returns a new object — never mutates
 * the input, so the original schema (used for tool dispatch / future
 * consumers) stays intact.
 */
export function sanitizeSchemaForLlm(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForLlm);
  if (!schema || typeof schema !== 'object') return schema;
  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t): t is string => typeof t === 'string');
      const nonNull = types.filter((t) => t !== 'null');
      if (nonNull.length > 0) out.type = nonNull[0];
      else if (types.length > 0) out.type = types[0];
      if (types.includes('null')) out.nullable = true;
    } else {
      out[k] = sanitizeSchemaForLlm(v);
    }
  }
  return out;
}

async function* parseSseChunks(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<OpenAIChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx;
      while ((nlIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIdx).trimEnd();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        if (line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data) as OpenAIChunk;
        } catch {
          // ignore non-JSON keepalives
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
