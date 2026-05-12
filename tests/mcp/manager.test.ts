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

describe('adapt — pollUrl envelope polling', () => {
  const def: McpToolDef = {
    name: 'agent_invoke',
    description: 'Start a persistent agent',
    inputSchema: { type: 'object' },
  };
  const ctx = {
    cwd: '/',
    signal: new AbortController().signal,
    sessionState: { readFiles: new Set<string>() },
  };

  it('polls pollUrl until status=done and returns the formatted result', async () => {
    const envelope = {
      runId: 'r1',
      pollUrl: 'http://localhost:9205/api/v1/agents/executions/r1',
      status: 'running',
      agentName: 'researcher',
    };
    const client = fakeClient({
      call: async () => ({ content: JSON.stringify(envelope), isError: false }),
    });
    const responses = [
      { ok: true, json: async () => ({ status: 'running' }) },
      { ok: true, json: async () => ({ status: 'done', result: 'hello', durationMs: 1234, agentName: 'researcher' }) },
    ];
    const fetchSpy = vi.fn(async () => responses.shift() as any);
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const tool = adapt('xerro', def, client, () => {});
      const result = await tool!.handler({ agentId: 'x', prompt: 'hi' }, ctx);
      expect(result.isError).toBe(false);
      expect(result.content).toContain('**researcher result** (completed in 1s)');
      expect(result.content).toContain('hello');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const url = (fetchSpy.mock.calls[0]?.[0] ?? '') as string;
      expect(url).toContain('pollUrl' in envelope ? envelope.pollUrl : '');
      expect(url).toContain('wait=20');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns isError when the agent reports failed status', async () => {
    const envelope = {
      runId: 'r2',
      pollUrl: 'http://localhost:9205/api/v1/agents/executions/r2',
      status: 'running',
      agentName: 'broken',
    };
    const client = fakeClient({
      call: async () => ({ content: JSON.stringify(envelope), isError: false }),
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'failed', error: 'boom', agentName: 'broken' }),
    })) as any);
    try {
      const tool = adapt('xerro', def, client, () => {});
      const result = await tool!.handler({}, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('**broken failed**: boom');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('forwards authHeader from the envelope into the fetch headers', async () => {
    const envelope = {
      runId: 'r3',
      pollUrl: 'http://remote.example/api/v1/agents/executions/r3',
      authHeader: 'Bearer secret-token',
      status: 'running',
    };
    const client = fakeClient({
      call: async () => ({ content: JSON.stringify(envelope), isError: false }),
    });
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: 'done', result: 'ok' }),
    })) as any;
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const tool = adapt('xerro', def, client, () => {});
      await tool!.handler({}, ctx);
      const opts = fetchSpy.mock.calls[0]?.[1];
      expect(opts?.headers).toEqual({ Authorization: 'Bearer secret-token' });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes through non-envelope content verbatim (no polling)', async () => {
    const client = fakeClient({
      call: async () => ({ content: 'plain text result', isError: false }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy as any);
    try {
      const tool = adapt('xerro', def, client, () => {});
      const result = await tool!.handler({}, ctx);
      expect(result).toEqual({ content: 'plain text result', isError: false });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not poll when status is already done', async () => {
    const envelope = {
      runId: 'r4',
      pollUrl: 'http://localhost:9205/api/v1/agents/executions/r4',
      status: 'done',
      result: 'already finished',
    };
    const client = fakeClient({
      call: async () => ({ content: JSON.stringify(envelope), isError: false }),
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy as any);
    try {
      const tool = adapt('xerro', def, client, () => {});
      const result = await tool!.handler({}, ctx);
      expect(result.content).toBe(JSON.stringify(envelope));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('aborts polling when the context signal aborts', async () => {
    const envelope = {
      runId: 'r5',
      pollUrl: 'http://localhost:9205/api/v1/agents/executions/r5',
      status: 'running',
    };
    const client = fakeClient({
      call: async () => ({ content: JSON.stringify(envelope), isError: false }),
    });
    const controller = new AbortController();
    const fetchSpy = vi.fn(async (_url: string, opts: any) => {
      await new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
      throw new Error('unreachable');
    }) as any;
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const tool = adapt('xerro', def, client, () => {});
      const pending = tool!.handler({}, { ...ctx, signal: controller.signal });
      setTimeout(() => controller.abort(), 10);
      const result = await pending;
      expect(result).toEqual({ content: 'aborted', isError: true });
    } finally {
      vi.unstubAllGlobals();
    }
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
