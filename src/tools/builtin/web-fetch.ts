import { z } from 'zod';
import { tool } from '../helper.js';

const MAX_FETCH_BYTES = 1_500_000;
const MAX_CONTENT_CHARS = 100_000;

const schema = z.object({
  url: z
    .string()
    .url()
    .describe('Absolute URL to fetch. http and https only.'),
  prompt: z
    .string()
    .min(1)
    .describe('What to extract or answer from the page. Used to drive a follow-up LLM read.'),
});

export const WebFetchTool = tool(
  'WebFetch',
  'Fetch a web page and answer a question about it. The tool downloads the URL, ' +
    'converts HTML to plain text, and runs a side LLM call against (page content + your prompt). ' +
    'Returns the model\'s answer. Useful for summarizing or extracting facts from documentation, ' +
    'release notes, blog posts, etc. Does NOT execute JavaScript.',
  schema,
  async ({ url, prompt }, ctx) => {
    if (!/^https?:\/\//i.test(url)) {
      return { content: `Error: only http(s) URLs are supported. Got: ${url}`, isError: true };
    }

    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctx.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'lcode/0.0.1 (+local)' },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to fetch ${url}: ${msg}`, isError: true };
    }

    if (!res.ok) {
      return { content: `Error: HTTP ${res.status} ${res.statusText} from ${url}`, isError: true };
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    let body: string;
    try {
      body = await readCappedText(res, MAX_FETCH_BYTES);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to read body of ${url}: ${msg}`, isError: true };
    }

    let pageText: string;
    if (contentType.includes('html') || /^\s*<(!doctype|html)/i.test(body)) {
      pageText = htmlToText(body);
    } else {
      pageText = body;
    }
    const truncated = pageText.length > MAX_CONTENT_CHARS;
    if (truncated) pageText = pageText.slice(0, MAX_CONTENT_CHARS);

    if (!ctx.runCompletion) {
      // No LLM wired (e.g. out-of-loop dispatch) — return the cleaned page so
      // the caller still gets something useful instead of erroring.
      return {
        content:
          `# ${url}\n\n${pageText}` +
          (truncated ? `\n\n[content truncated at ${MAX_CONTENT_CHARS} chars]` : ''),
      };
    }

    let answer: string;
    try {
      answer = await ctx.runCompletion({
        systemPrompt:
          'You are answering a question using ONLY the provided web page content. ' +
          'Be concise and faithful to the source. If the page does not contain the answer, ' +
          "say so. Cite the URL once at the end as 'Source: <url>'.",
        userPrompt:
          `URL: ${url}\n` +
          `Question: ${prompt}\n\n` +
          `--- PAGE CONTENT${truncated ? ' (truncated)' : ''} ---\n` +
          pageText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: LLM call failed for ${url}: ${msg}`, isError: true };
    }

    return { content: answer.trim() };
  },
  { readOnly: true },
);

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let received = 0;
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      out += decoder.decode(value.subarray(0, Math.max(0, maxBytes - (received - value.byteLength))));
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/**
 * Cheap-and-cheerful HTML → text. Strips script/style/noscript/comments,
 * turns common block closers into newlines, drops remaining tags, and
 * decodes a handful of named entities. Not a real parser — good enough
 * for a small model to reason over the body of an article.
 */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|article|section|header|footer|nav|aside)>/gi, '\n');
  s = s.replace(/<br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  s = s
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}
