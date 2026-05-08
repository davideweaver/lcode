import { zodToJsonSchema } from 'zod-to-json-schema';
import type {
  AnthropicMessage,
  ContentBlock,
  PartialAssistantEvent,
  Usage,
} from './messages.js';
import type { Tool } from '../tools/types.js';

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
    if (delta?.content) {
      textAccum += delta.content;
      yield { kind: 'text_delta', text: delta.content };
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

  const content: ContentBlock[] = [];
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
      const text = msg.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
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
      parameters: zodToJsonSchema(t.inputSchema, { target: 'openApi3' }),
    },
  }));
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
