import { describe, expect, it, vi } from 'vitest';
import { adapt, McpManager, normalizeServerName } from '../../src/mcp/manager.js';
import type { McpClient, McpToolDef } from '../../src/mcp/client.js';
import type { McpServerConfig } from '../../src/mcp/types.js';

function fakeClient(opts: {
  tools?: McpToolDef[];
  call?: (name: string, args: unknown) => Promise<{ content: string; isError: boolean }>;
}): McpClient {
  return {
    listTools: async () => opts.tools ?? [],
    callTool: opts.call ?? (async () => ({ content: 'ok', isError: false })),
    close: async () => {},
  };
}

describe('normalizeServerName', () => {
  it('lowercases and replaces non-alphanumeric chars with underscore', () => {
    expect(normalizeServerName('Context7')).toBe('context7');
    expect(normalizeServerName('my-server')).toBe('my_server');
    expect(normalizeServerName('foo.bar')).toBe('foo_bar');
    expect(normalizeServerName('xerro')).toBe('xerro');
  });
});

describe('adapt (single tool)', () => {
  const def: McpToolDef = {
    name: 'resolve-library-id',
    description: 'Resolves a library ID',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  };

  it('builds mcp__<server>__<tool> name (Claude Code style)', () => {
    const tool = adapt('context7', def, fakeClient({}), () => {});
    expect(tool?.name).toBe('mcp__context7__resolve-library-id');
  });

  it('passes the server-provided JSON schema through to inputJsonSchema', () => {
    const tool = adapt('context7', def, fakeClient({}), () => {});
    expect(tool?.inputJsonSchema).toEqual(def.inputSchema);
  });

  it('routes handler calls into the underlying client', async () => {
    const call = vi.fn(async () => ({ content: 'cool', isError: false }));
    const tool = adapt('context7', def, fakeClient({ call }), () => {});
    const result = await tool!.handler(
      { name: 'react' },
      { cwd: '/', signal: new AbortController().signal, sessionState: { readFiles: new Set() } },
    );
    expect(call).toHaveBeenCalledWith('resolve-library-id', { name: 'react' });
    expect(result).toEqual({ content: 'cool', isError: false });
  });

  it('rejects tool names exceeding 64 chars and warns', () => {
    const long: McpToolDef = { name: 'x'.repeat(80), inputSchema: {} };
    const warn = vi.fn();
    const tool = adapt('s', long, fakeClient({}), warn);
    expect(tool).toBeNull();
    expect(warn).toHaveBeenCalled();
  });
});

describe('McpManager', () => {
  it('connects all servers in parallel and exposes adapter tools', async () => {
    const configs: McpServerConfig[] = [
      { type: 'http', name: 'one', url: 'http://1' },
      { type: 'http', name: 'two', url: 'http://2' },
    ];
    const m = new McpManager(configs, {
      connect: async (cfg) =>
        fakeClient({
          tools: [
            { name: `${cfg.name}-tool`, inputSchema: { type: 'object' } },
          ],
        }),
    });
    await m.start();
    const tools = m.tools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'mcp__one__one-tool',
      'mcp__two__two-tool',
    ]);
    const status = m.status();
    expect(status.get('one')?.state).toBe('ready');
    expect(status.get('two')?.state).toBe('ready');
  });

  it('records a failed status when one server connect throws but keeps the rest', async () => {
    const configs: McpServerConfig[] = [
      { type: 'http', name: 'good', url: 'http://1' },
      { type: 'http', name: 'broken', url: 'http://2' },
    ];
    const m = new McpManager(configs, {
      connect: async (cfg) => {
        if (cfg.name === 'broken') throw new Error('boom');
        return fakeClient({ tools: [{ name: 'ping', inputSchema: {} }] });
      },
    });
    await m.start();
    expect(m.status().get('good')?.state).toBe('ready');
    expect(m.status().get('broken')).toMatchObject({ state: 'failed', error: 'boom' });
    expect(m.tools().map((t) => t.name)).toEqual(['mcp__good__ping']);
  });

  it('reload reconnects everything', async () => {
    const configs: McpServerConfig[] = [
      { type: 'http', name: 'one', url: 'http://1' },
    ];
    const connect = vi.fn(async () =>
      fakeClient({ tools: [{ name: 'ping', inputSchema: {} }] }),
    );
    const m = new McpManager(configs, { connect });
    await m.start();
    expect(connect).toHaveBeenCalledTimes(1);
    await m.reload();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(m.status().get('one')?.state).toBe('ready');
  });

  it('close calls close on every active client', async () => {
    const close = vi.fn(async () => {});
    const m = new McpManager([{ type: 'http', name: 'one', url: 'http://1' }], {
      connect: async () => ({ ...fakeClient({}), close }),
    });
    await m.start();
    await m.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('transportOf returns the configured transport', async () => {
    const m = new McpManager(
      [
        { type: 'stdio', name: 'a', command: 'echo' },
        { type: 'sse', name: 'b', url: 'http://x' },
      ],
      { connect: async () => fakeClient({}) },
    );
    await m.start();
    expect(m.transportOf('a')).toBe('stdio');
    expect(m.transportOf('b')).toBe('sse');
    expect(m.transportOf('missing')).toBeNull();
  });
});
