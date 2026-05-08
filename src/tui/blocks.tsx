import { Box, Text } from 'ink';
import { MarkdownText } from './markdown.js';
import type { UiBlock } from './types.js';

export function BlockList({ blocks }: { blocks: UiBlock[] }) {
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </Box>
  );
}

function BlockView({ block }: { block: UiBlock }) {
  switch (block.kind) {
    case 'user_prompt':
      return (
        <Box marginTop={1}>
          <Text color="cyan">› </Text>
          <Text>{block.text}</Text>
        </Box>
      );
    case 'assistant_text':
      return (
        <Box marginTop={1} flexDirection="column">
          <MarkdownText>{block.text}</MarkdownText>
          {block.streaming && <Text dimColor>▋</Text>}
        </Box>
      );
    case 'tool_call': {
      const color =
        block.status === 'pending'
          ? 'yellow'
          : block.status === 'error'
            ? 'red'
            : 'green';
      const indicator =
        block.status === 'pending' ? '…' : block.status === 'error' ? '✗' : '✓';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color}>
            {indicator} {block.name}
            <Text dimColor>({summarizeInput(block.input)})</Text>
          </Text>
          {block.result && block.status !== 'pending' && (
            <Box marginLeft={2} marginTop={0}>
              <Text dimColor>{truncate(block.result, 600)}</Text>
            </Box>
          )}
        </Box>
      );
    }
    case 'result':
      if (block.subtype === 'success') return null;
      return (
        <Box marginTop={1}>
          <Text color="red">[{block.subtype}]</Text>
          {block.text && <Text> {block.text}</Text>}
        </Box>
      );
    case 'error':
      return (
        <Box marginTop={1}>
          <Text color="red">error: {block.text}</Text>
        </Box>
      );
    case 'slash_output':
      return (
        <Box marginTop={1}>
          <Text dimColor>{block.text}</Text>
        </Box>
      );
  }
}

function summarizeInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const first = entries[0]!;
  const value = stringify(first[1]);
  const head = `${first[0]}=${value}`;
  return entries.length > 1 ? `${head}, …+${entries.length - 1}` : head;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 57) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return truncate(JSON.stringify(v), 60);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}
