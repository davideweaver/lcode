import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebFetchTool, htmlToText } from '../src/tools/builtin/web-fetch.js';
import { WebSearchTool, domainMatches } from '../src/tools/builtin/web-search.js';
import { newSessionState, type ToolContext } from '../src/tools/types.js';

interface CtxOverrides {
  searxngUrl?: string;
  runCompletion?: ToolContext['runCompletion'];
}

function mkCtx(overrides: CtxOverrides = {}): ToolContext {
  return {
    cwd: '/tmp',
    signal: new AbortController().signal,
    sessionState: newSessionState(),
    ...overrides,
  };
}

function mockFetchOnce(response: { status?: number; statusText?: string; headers?: Record<string, string>; body: string }) {
  const init = { status: response.status ?? 200, statusText: response.statusText ?? 'OK' };
  const headers = new Headers(response.headers ?? {});
  globalThis.fetch = vi.fn().mockResolvedValue(
    new Response(response.body, { ...init, headers }),
  ) as unknown as typeof fetch;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('htmlToText', () => {
  it('strips scripts, styles, and comments', () => {
    const html = `
      <html><head><style>body{color:red}</style></head>
      <body>
        <script>alert(1)</script>
        <!-- ignore me -->
        <h1>Hello</h1>
        <p>World &amp; friends.</p>
      </body></html>`;
    const text = htmlToText(html);
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('ignore me');
    expect(text).toContain('Hello');
    expect(text).toContain('World & friends.');
  });

  it('preserves block boundaries with newlines', () => {
    const text = htmlToText('<p>one</p><p>two</p>');
    expect(text).toBe('one\ntwo');
  });
});

describe('WebFetch', () => {
  it('errors on non-http url', async () => {
    const result = await WebFetchTool.handler(
      { url: 'ftp://example.com', prompt: 'x' },
      mkCtx(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/only http/);
  });

  it('fetches HTML, converts to text, calls runCompletion, returns the answer', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><h1>Title</h1><p>Body text.</p></body></html>',
    });
    const runCompletion = vi.fn().mockResolvedValue('  the answer  ');
    const result = await WebFetchTool.handler(
      { url: 'https://example.com/post', prompt: 'what is the title?' },
      mkCtx({ runCompletion }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('the answer');
    expect(runCompletion).toHaveBeenCalledTimes(1);
    const call = runCompletion.mock.calls[0]![0]!;
    expect(call.userPrompt).toContain('Title');
    expect(call.userPrompt).toContain('Body text.');
    expect(call.userPrompt).toContain('https://example.com/post');
    expect(call.userPrompt).toContain('what is the title?');
  });

  it('falls back to returning page text when no runCompletion is wired', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'text/html' },
      body: '<p>Just text.</p>',
    });
    const result = await WebFetchTool.handler(
      { url: 'https://example.com', prompt: 'q' },
      mkCtx(),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('https://example.com');
    expect(result.content).toContain('Just text.');
  });

  it('surfaces non-2xx HTTP as an error', async () => {
    mockFetchOnce({ status: 404, statusText: 'Not Found', body: 'nope' });
    const result = await WebFetchTool.handler(
      { url: 'https://example.com/missing', prompt: 'q' },
      mkCtx({ runCompletion: vi.fn() }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/404/);
  });
});

describe('domainMatches', () => {
  it('matches exact host', () => {
    expect(domainMatches('https://example.com/x', 'example.com')).toBe(true);
  });
  it('matches subdomain', () => {
    expect(domainMatches('https://docs.example.com/x', 'example.com')).toBe(true);
  });
  it('does not match unrelated host', () => {
    expect(domainMatches('https://evil.com/example.com', 'example.com')).toBe(false);
  });
  it('handles wildcard prefix and scheme noise', () => {
    expect(domainMatches('https://api.foo.dev', 'https://*.foo.dev')).toBe(true);
  });
});

describe('WebSearch', () => {
  it('errors when SearXNG URL is not configured', async () => {
    const result = await WebSearchTool.handler({ query: 'hello world' }, mkCtx());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/LCODE_SEARXNG_URL/);
  });

  it('formats top results from SearXNG JSON', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        results: [
          { title: 'First', url: 'https://a.example.com/1', content: 'snippet one' },
          { title: 'Second', url: 'https://b.example.com/2', content: 'snippet two' },
        ],
      }),
    });
    const result = await WebSearchTool.handler(
      { query: 'foo' },
      mkCtx({ searxngUrl: 'http://searx.local:8080' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('1. First');
    expect(result.content).toContain('https://a.example.com/1');
    expect(result.content).toContain('snippet one');
    expect(result.content).toContain('2. Second');
  });

  it('honors allowed_domains', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        results: [
          { title: 'Allowed', url: 'https://docs.example.com/a', content: '' },
          { title: 'Blocked', url: 'https://news.evil.org/b', content: '' },
        ],
      }),
    });
    const result = await WebSearchTool.handler(
      { query: 'q', allowed_domains: ['example.com'] },
      mkCtx({ searxngUrl: 'http://searx.local' }),
    );
    expect(result.content).toContain('Allowed');
    expect(result.content).not.toContain('Blocked');
  });

  it('honors blocked_domains', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        results: [
          { title: 'Keep', url: 'https://good.example.com/a', content: '' },
          { title: 'Drop', url: 'https://spam.example.com/b', content: '' },
        ],
      }),
    });
    const result = await WebSearchTool.handler(
      { query: 'q', blocked_domains: ['spam.example.com'] },
      mkCtx({ searxngUrl: 'http://searx.local' }),
    );
    expect(result.content).toContain('Keep');
    expect(result.content).not.toContain('Drop');
  });

  it('reports SearXNG error responses', async () => {
    mockFetchOnce({ status: 500, statusText: 'Server Error', body: '' });
    const result = await WebSearchTool.handler(
      { query: 'q' },
      mkCtx({ searxngUrl: 'http://searx.local' }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/500/);
  });

  it('returns "no results" when SearXNG returns empty', async () => {
    mockFetchOnce({
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ results: [] }),
    });
    const result = await WebSearchTool.handler(
      { query: 'obscure' },
      mkCtx({ searxngUrl: 'http://searx.local' }),
    );
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/No results for "obscure"/);
  });
});
