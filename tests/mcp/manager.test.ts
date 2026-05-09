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

  it('accepts entries carrying a source path and exposes it via sourceOf', async () => {
    const m = new McpManager(
      [
        { config: { type: 'http', name: 'one', url: 'http://1' }, source: '/etc/lcode/mcp.json' },
        { config: { type: 'http', name: 'two', url: 'http://2' } }, // no source
      ],
      { connect: async () => fakeClient({}) },
    );
    await m.start();
    expect(m.sourceOf('one')).toBe('/etc/lcode/mcp.json');
    expect(m.sourceOf('two')).toBeNull();
    expect(m.sourceOf('missing')).toBeNull();
  });

  it('toolsFor returns only that server tools', async () => {
    const m = new McpManager(
      [
        { type: 'http', name: 'one', url: 'http://1' },
        { type: 'http', name: 'two', url: 'http://2' },
      ],
      {
        connect: async (cfg) =>
          fakeClient({ tools: [{ name: `${cfg.name}-t`, inputSchema: {} }] }),
      },
    );
    await m.start();
    expect(m.toolsFor('one').map((t) => t.name)).toEqual(['mcp__one__one-t']);
    expect(m.toolsFor('two').map((t) => t.name)).toEqual(['mcp__two__two-t']);
    expect(m.toolsFor('missing')).toEqual([]);
  });

  it('reconnect refreshes a single server without touching the rest', async () => {
    const calls: string[] = [];
    const m = new McpManager(
      [
        { type: 'http', name: 'one', url: 'http://1' },
        { type: 'http', name: 'two', url: 'http://2' },
      ],
      {
        connect: async (cfg) => {
          calls.push(cfg.name);
          return fakeClient({ tools: [{ name: 'ping', inputSchema: {} }] });
        },
      },
    );
    await m.start();
    expect(calls.sort()).toEqual(['one', 'two']);
    calls.length = 0;
    await m.reconnect('one');
    expect(calls).toEqual(['one']);
    expect(m.status().get('one')?.state).toBe('ready');
    expect(m.status().get('two')?.state).toBe('ready');
  });

  it('skips connection for disabled servers at start', async () => {
    const connect = vi.fn(async () => fakeClient({ tools: [{ name: 'ping', inputSchema: {} }] }));
    const m = new McpManager(
      [
        { type: 'http', name: 'on', url: 'http://1' },
        { type: 'http', name: 'off', url: 'http://2' },
      ],
      { connect, disabled: new Set(['off']) },
    );
    await m.start();
    expect(connect).toHaveBeenCalledTimes(1);
    expect(m.status().get('on')?.state).toBe('ready');
    expect(m.status().get('off')?.state).toBe('disabled');
    expect(m.isDisabled('off')).toBe(true);
    expect(m.tools().map((t) => t.name)).toEqual(['mcp__on__ping']);
  });

  it('disable closes the client, drops tools, and persists', async () => {
    const close = vi.fn(async () => {});
    const persist = vi.fn(async () => {});
    const m = new McpManager(
      [{ type: 'http', name: 'one', url: 'http://1' }],
      {
        connect: async () => ({
          ...fakeClient({ tools: [{ name: 'ping', inputSchema: {} }] }),
          close,
        }),
        persistDisabled: persist,
      },
    );
    await m.start();
    expect(m.tools()).toHaveLength(1);
    await m.disable('one');
    expect(m.status().get('one')?.state).toBe('disabled');
    expect(m.tools()).toHaveLength(0);
    expect(close).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('one', true);
  });

  it('enable persists, reconnects, and re-exposes tools', async () => {
    const persist = vi.fn(async () => {});
    const m = new McpManager(
      [{ type: 'http', name: 'one', url: 'http://1' }],
      {
        connect: async () => fakeClient({ tools: [{ name: 'ping', inputSchema: {} }] }),
        disabled: new Set(['one']),
        persistDisabled: persist,
      },
    );
    await m.start();
    expect(m.status().get('one')?.state).toBe('disabled');
    expect(m.tools()).toHaveLength(0);
    await m.enable('one');
    expect(persist).toHaveBeenCalledWith('one', false);
    expect(m.status().get('one')?.state).toBe('ready');
    expect(m.tools()).toHaveLength(1);
  });
});
