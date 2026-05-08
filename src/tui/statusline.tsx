import { Box, Text } from 'ink';
import { formatTokenCount, tokenStats } from './tokens.js';

interface StatusLineProps {
  folderLabel: string;
  branch: string | null;
  tokensUsed: number;
  contextWindow: number;
  sessionId?: string;
}

const BAR_WIDTH = 20;

export function StatusLine({
  folderLabel,
  branch,
  tokensUsed,
  contextWindow,
  sessionId,
}: StatusLineProps) {
  const stats = tokenStats(tokensUsed, contextWindow);
  const filled = Math.round((stats.percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const barColor =
    stats.percent >= 90 ? 'red' : stats.percent >= 70 ? 'yellow' : 'green';

  return (
    <Box paddingX={1}>
      <Text>
        <Text bold>{folderLabel}</Text>
        {branch && <Text dimColor>  ({branch})</Text>}
        <Text>  </Text>
        <Text color={barColor}>{'█'.repeat(filled)}</Text>
        <Text dimColor>{'░'.repeat(empty)}</Text>
        <Text>  </Text>
        <Text color={barColor}>{stats.percent}%</Text>
        <Text dimColor>  {formatTokenCount(contextWindow)}</Text>
        {sessionId && <Text dimColor>  ({sessionId.slice(0, 8)})</Text>}
      </Text>
    </Box>
  );
}
