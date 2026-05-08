import { z } from 'zod';
import { tool } from '../helper.js';

const MAX_RESULTS = 10;
const SNIPPET_MAX = 280;

const schema = z.object({
  query: z.string().min(2).describe('Search query.'),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe(
      'If set, only return results whose host equals or ends with one of these. ' +
        "Bare hostnames work ('example.com' matches 'docs.example.com').",
    ),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe('Drop results whose host matches one of these (same matching as allowed_domains).'),
});

interface SearxngResult {
  title?: string;
  url?: string;
  content?: string;
}

interface SearxngResponse {
  results?: SearxngResult[];
  // SearXNG also returns `infoboxes`, `suggestions`, etc. — we only use `results`.
}

export const WebSearchTool = tool(
  'WebSearch',
  'Search the web via the configured SearXNG instance. Returns titles, URLs, and snippets ' +
    'for the top results. Set LCODE_SEARXNG_URL to enable. Use WebFetch on a returned URL to ' +
    'read a specific page in detail.',
  schema,
  async ({ query, allowed_domains, blocked_domains }, ctx) => {
    const base = ctx.searxngUrl?.trim();
    if (!base) {
      return {
        content:
          'Error: WebSearch is not configured. Set LCODE_SEARXNG_URL to your SearXNG ' +
          'base URL (e.g. http://searxng.local:8080) and restart lcode.',
        isError: true,
      };
    }

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      safesearch: '0',
    });
    const searchUrl = `${base.replace(/\/+$/, '')}/search?${params.toString()}`;

    let res: Response;
    try {
      res = await fetch(searchUrl, {
        signal: ctx.signal,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'lcode/0.0.1 (+local)',
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Error: failed to reach SearXNG at ${base}: ${msg}`, isError: true };
    }
    if (!res.ok) {
      return {
        content: `Error: SearXNG ${res.status} ${res.statusText} for query "${query}".`,
        isError: true,
      };
    }

    let body: SearxngResponse;
    try {
      body = (await res.json()) as SearxngResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content:
          `Error: SearXNG response was not JSON. Make sure JSON output is enabled in your ` +
          `SearXNG settings (settings.yml -> search.formats includes 'json'). (${msg})`,
        isError: true,
      };
    }

    let results = (body.results ?? []).filter((r): r is Required<Pick<SearxngResult, 'url'>> & SearxngResult =>
      typeof r.url === 'string' && r.url.length > 0,
    );

    if (allowed_domains && allowed_domains.length > 0) {
      results = results.filter((r) => allowed_domains.some((d) => domainMatches(r.url!, d)));
    }
    if (blocked_domains && blocked_domains.length > 0) {
      results = results.filter((r) => !blocked_domains.some((d) => domainMatches(r.url!, d)));
    }

    if (results.length === 0) {
      return { content: `No results for "${query}".` };
    }

    const top = results.slice(0, MAX_RESULTS);
    const lines = top.map((r, i) => {
      const title = (r.title ?? '(no title)').trim();
      const snippet = trimSnippet(r.content ?? '');
      return `${i + 1}. ${title}\n   ${r.url}\n   ${snippet}`;
    });
    return { content: lines.join('\n\n') };
  },
  { readOnly: true },
);

export function domainMatches(url: string, pattern: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const p = pattern
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^\*\./, '')
    .replace(/\/.*$/, '');
  if (!p) return false;
  return host === p || host.endsWith('.' + p);
}

function trimSnippet(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? flat.slice(0, SNIPPET_MAX - 1) + '…' : flat;
}
