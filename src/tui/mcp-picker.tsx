import { Box, Text, useInput } from 'ink';
import { useMemo, useReducer, useState } from 'react';
import type { McpManager } from '../mcp/manager.js';
import type { Tool } from '../tools/types.js';
import type { McpServerConfig, McpServerStatus } from '../mcp/types.js';
import { scopeFromSource, type McpScope } from '../mcp/config.js';
import { Divider } from './divider.js';

interface McpPickerProps {
  mcpManager: McpManager;
  onCancel: () => void;
}

type View =
  | { kind: 'list'; idx: number }
  | { kind: 'server'; name: string; actionIdx: number }
  | { kind: 'tools'; name: string; idx: number }
  | { kind: 'tool'; server: string; tool: string };

const PAGE_SIZE = 10;

interface ServerRow {
  name: string;
  status: McpServerStatus;
}

function listServers(mgr: McpManager): ServerRow[] {
  return [...mgr.status().entries()].map(([name, status]) => ({ name, status }));
}

function statusIcon(s: McpServerStatus): string {
  switch (s.state) {
    case 'ready':
      return '✓';
    case 'connecting':
      return '⏳';
    case 'failed':
      return '✗';
    case 'disabled':
      return '⊘';
  }
}

function statusColor(s: McpServerStatus): string | undefined {
  switch (s.state) {
    case 'ready':
      return 'green';
    case 'connecting':
      return 'yellow';
    case 'failed':
      return 'red';
    case 'disabled':
      return 'gray';
  }
}

function statusDetail(s: McpServerStatus): string {
  switch (s.state) {
    case 'ready':
      return `${s.toolCount} tools, ${s.latencyMs}ms`;
    case 'connecting':
      return 'connecting…';
    case 'failed':
      return `failed: ${s.error}`;
    case 'disabled':
      return 'disabled';
  }
}

function commandLine(cfg: McpServerConfig): string {
  if (cfg.type === 'stdio') {
    return cfg.args && cfg.args.length > 0
      ? `${cfg.command} ${cfg.args.join(' ')}`
      : cfg.command;
  }
  return cfg.url;
}

export function McpPicker({ mcpManager, onCancel }: McpPickerProps) {
  const [view, setView] = useState<View>({ kind: 'list', idx: 0 });
  // Manager state (status, tools) mutates in place; bump this to force a
  // re-render after disable/enable/reconnect resolves.
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  const servers = useMemo(() => listServers(mcpManager), [mcpManager, view]);

  if (view.kind === 'list') {
    return (
      <ServerListView
        mcpManager={mcpManager}
        servers={servers}
        selectedIdx={view.idx}
        onMove={(idx) => setView({ kind: 'list', idx })}
        onPick={(name) => setView({ kind: 'server', name, actionIdx: 0 })}
        onCancel={onCancel}
      />
    );
  }
  if (view.kind === 'server') {
    return (
      <ServerDetailView
        mcpManager={mcpManager}
        name={view.name}
        actionIdx={view.actionIdx}
        onMoveAction={(actionIdx) => setView({ kind: 'server', name: view.name, actionIdx })}
        onAction={async (action) => {
          if (action === 'tools') {
            setView({ kind: 'tools', name: view.name, idx: 0 });
          } else if (action === 'reconnect') {
            await mcpManager.reconnect(view.name);
            refresh();
          } else if (action === 'disable') {
            await mcpManager.disable(view.name);
            refresh();
          } else if (action === 'enable') {
            await mcpManager.enable(view.name);
            refresh();
          }
        }}
        onBack={() => setView({ kind: 'list', idx: indexOf(servers, view.name) })}
      />
    );
  }
  if (view.kind === 'tools') {
    return (
      <ToolListView
        mcpManager={mcpManager}
        serverName={view.name}
        selectedIdx={view.idx}
        onMove={(idx) => setView({ kind: 'tools', name: view.name, idx })}
        onPick={(toolName) => setView({ kind: 'tool', server: view.name, tool: toolName })}
        onBack={() => setView({ kind: 'server', name: view.name, actionIdx: 0 })}
      />
    );
  }
  return (
    <ToolDetailView
      mcpManager={mcpManager}
      serverName={view.server}
      toolName={view.tool}
      onBack={() => setView({ kind: 'tools', name: view.server, idx: 0 })}
    />
  );
}

function indexOf(servers: ServerRow[], name: string): number {
  const i = servers.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i;
}

function ServerListView({
  mcpManager,
  servers,
  selectedIdx,
  onMove,
  onPick,
  onCancel,
}: {
  mcpManager: McpManager;
  servers: ServerRow[];
  selectedIdx: number;
  onMove: (idx: number) => void;
  onPick: (name: string) => void;
  onCancel: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (servers.length === 0) return;
    if (key.upArrow) {
      onMove(Math.max(0, selectedIdx - 1));
      return;
    }
    if (key.downArrow) {
      onMove(Math.min(servers.length - 1, selectedIdx + 1));
      return;
    }
    if (key.return) {
      const picked = servers[selectedIdx];
      if (picked) onPick(picked.name);
    }
  });

  const nameWidth = Math.max(...servers.map((s) => s.name.length), 6);

  const pageStart = Math.max(
    0,
    Math.min(servers.length - PAGE_SIZE, selectedIdx - Math.floor(PAGE_SIZE / 2)),
  );
  const visible = servers.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Select MCP Server ({selectedIdx + 1} of {servers.length})
        </Text>
      </Box>
      {visible.map((row, i) => {
        const idx = pageStart + i;
        const selected = idx === selectedIdx;
        const transport = (mcpManager.transportOf(row.name) ?? '?').padEnd(5);
        const scope = scopeFromSource(mcpManager.sourceOf(row.name)).padEnd(7);
        return (
          <Box key={row.name}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
              </Text>
              <Text color={statusColor(row.status)}>{statusIcon(row.status)} </Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {row.name.padEnd(nameWidth)}
              </Text>
              <Text color="gray">  {transport}  {scope}  {statusDetail(row.status)}</Text>
            </Text>
          </Box>
        );
      })}
      {pageStart + visible.length < servers.length && (
        <Box marginTop={1}>
          <Text color="gray">  …{servers.length - pageStart - visible.length} more below</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · enter for details · esc to cancel</Text>
      </Box>
    </Box>
  );
}

type ServerAction = 'tools' | 'reconnect' | 'disable' | 'enable';

function ServerDetailView({
  mcpManager,
  name,
  actionIdx,
  onMoveAction,
  onAction,
  onBack,
}: {
  mcpManager: McpManager;
  name: string;
  actionIdx: number;
  onMoveAction: (idx: number) => void;
  onAction: (action: ServerAction) => void | Promise<void>;
  onBack: () => void;
}) {
  const status = mcpManager.status().get(name);
  const config = mcpManager.configOf(name);
  const source = mcpManager.sourceOf(name);
  const tools = mcpManager.toolsFor(name);

  const isDisabled = status?.state === 'disabled';
  const actions: { id: ServerAction; label: string; enabled: boolean }[] = [
    { id: 'tools', label: 'View tools', enabled: tools.length > 0 },
    { id: 'reconnect', label: 'Reconnect', enabled: !isDisabled },
    isDisabled
      ? { id: 'enable', label: 'Enable', enabled: true }
      : { id: 'disable', label: 'Disable', enabled: true },
  ];

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (key.upArrow) {
      onMoveAction(Math.max(0, actionIdx - 1));
      return;
    }
    if (key.downArrow) {
      onMoveAction(Math.min(actions.length - 1, actionIdx + 1));
      return;
    }
    if (key.return) {
      const a = actions[actionIdx];
      if (a && a.enabled) void onAction(a.id);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {name} MCP Server
        </Text>
      </Box>
      <Field label="Status" value={renderStatus(status)} />
      {config && <Field label="Transport" value={config.type} />}
      {config && config.type === 'stdio' && (
        <Field label="Command" value={commandLine(config)} />
      )}
      {config && (config.type === 'http' || config.type === 'sse') && (
        <Field label="URL" value={config.url} />
      )}
      <Field label="Scope" value={describeScope(scopeFromSource(source))} />
      <Field label="Config location" value={source ?? '(unknown)'} />
      <Field label="Capabilities" value="tools" />
      <Field
        label="Tools"
        value={tools.length === 0 ? '(none)' : `${tools.length} tools`}
      />

      <Box marginTop={1} flexDirection="column">
        {actions.map((a, i) => {
          const selected = i === actionIdx;
          return (
            <Text key={a.id}>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {i + 1}. {a.label}
              </Text>
              {!a.enabled && <Text color="gray"> (unavailable)</Text>}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · enter to select · esc to back</Text>
      </Box>
    </Box>
  );
}

function describeScope(scope: McpScope): string {
  switch (scope) {
    case 'user':
      return 'user (~/.lcode/mcp.json)';
    case 'project':
      return 'project (.mcp.json)';
    case 'claude':
      return 'claude (~/.claude.json)';
    case 'unknown':
      return '(unknown)';
  }
}

function renderStatus(status: McpServerStatus | undefined): string {
  if (!status) return '(unknown)';
  switch (status.state) {
    case 'ready':
      return `✓ connected (${status.toolCount} tools, ${status.latencyMs}ms)`;
    case 'connecting':
      return '⏳ connecting…';
    case 'failed':
      return `✗ failed: ${status.error}`;
    case 'disabled':
      return '⊘ disabled';
  }
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={18}>
        <Text bold>{label}:</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

function ToolListView({
  mcpManager,
  serverName,
  selectedIdx,
  onMove,
  onPick,
  onBack,
}: {
  mcpManager: McpManager;
  serverName: string;
  selectedIdx: number;
  onMove: (idx: number) => void;
  onPick: (toolName: string) => void;
  onBack: () => void;
}) {
  const tools = mcpManager.toolsFor(serverName);

  useInput((_input, key) => {
    if (key.escape) {
      onBack();
      return;
    }
    if (tools.length === 0) return;
    if (key.upArrow) {
      onMove(Math.max(0, selectedIdx - 1));
      return;
    }
    if (key.downArrow) {
      onMove(Math.min(tools.length - 1, selectedIdx + 1));
      return;
    }
    if (key.return) {
      const picked = tools[selectedIdx];
      if (picked) onPick(picked.name);
    }
  });

  if (tools.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold color="cyan">
          {serverName} tools
        </Text>
        <Text color="gray">No tools available — server may be connecting, failed, or disabled.</Text>
        <Box marginTop={1}>
          <Text color="gray">esc to back</Text>
        </Box>
      </Box>
    );
  }

  const pageStart = Math.max(
    0,
    Math.min(tools.length - PAGE_SIZE, selectedIdx - Math.floor(PAGE_SIZE / 2)),
  );
  const visible = tools.slice(pageStart, pageStart + PAGE_SIZE);
  const nameWidth = Math.max(...tools.map((t) => t.name.length));

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="cyan">
          {serverName} tools ({selectedIdx + 1} of {tools.length})
        </Text>
        <Text color="gray">↑↓ navigate · enter for details · esc to back</Text>
      </Box>
      <Divider />
      {visible.map((tool, i) => {
        const idx = pageStart + i;
        const selected = idx === selectedIdx;
        const summary = firstLine(tool.description);
        return (
          <Box key={tool.name} marginTop={i === 0 ? 1 : 0}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {tool.name.padEnd(nameWidth)}
              </Text>
              {summary && <Text color="gray">  {summary}</Text>}
            </Text>
          </Box>
        );
      })}
      {pageStart + visible.length < tools.length && (
        <Box marginTop={1}>
          <Text color="gray">  …{tools.length - pageStart - visible.length} more below</Text>
        </Box>
      )}
    </Box>
  );
}

function ToolDetailView({
  mcpManager,
  serverName,
  toolName,
  onBack,
}: {
  mcpManager: McpManager;
  serverName: string;
  toolName: string;
  onBack: () => void;
}) {
  useInput((_input, key) => {
    if (key.escape || key.return) {
      onBack();
    }
  });
  const tool = findTool(mcpManager.toolsFor(serverName), toolName);

  if (!tool) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">Tool not found: {toolName}</Text>
        <Box marginTop={1}>
          <Text color="gray">esc to back</Text>
        </Box>
      </Box>
    );
  }

  const schemaJson = JSON.stringify(tool.inputJsonSchema ?? {}, null, 2);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {tool.name}
        </Text>
      </Box>
      {tool.description && (
        <Box marginBottom={1} flexDirection="column">
          <Text bold>Description:</Text>
          <Text>{tool.description}</Text>
        </Box>
      )}
      <Box flexDirection="column">
        <Text bold>Input schema:</Text>
        <Text color="gray">{schemaJson}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">esc or enter to back</Text>
      </Box>
    </Box>
  );
}

function findTool(tools: Tool[], name: string): Tool | null {
  return tools.find((t) => t.name === name) ?? null;
}

function firstLine(s: string | undefined): string {
  if (!s) return '';
  const idx = s.indexOf('\n');
  const line = idx >= 0 ? s.slice(0, idx) : s;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
