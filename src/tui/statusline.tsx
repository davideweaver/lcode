import { Box, Text } from 'ink';
import { formatTokenCount, tokenStats } from './tokens.js';

interface StatusLineProps {
  folderLabel: string;
  branch: string | null;
  tokensUsed: number;
  contextWindow: number;
  sessionId?: string;
  showThinking?: boolean;
}

const BAR_WIDTH = 20;

export function StatusLine({
  folderLabel,
  branch,
  tokensUsed,
  contextWindow,
  sessionId,
  showThinking,
}: StatusLineProps) {
  const stats = tokenStats(tokensUsed, contextWindow);
  const filled = Math.round((stats.percent / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const barColor =
    stats.percent >= 90 ? 'red' : stats.percent >= 70 ? 'yellow' : 'green';

  return (
    <Box>
      <Text>
        <Text bold>{folderLabel}</Text>
        {branch && <Text color="gray">  ({branch})</Text>}
        <Text>  </Text>
        <Text color={barColor}>{'█'.repeat(filled)}</Text>
        <Text color="gray">{'░'.repeat(empty)}</Text>
        <Text>  </Text>
        <Text color={barColor}>{stats.percent}%</Text>
        <Text color="gray">  {formatTokenCount(contextWindow)}</Text>
        {sessionId && <Text color="gray">  ({sessionId.slice(0, 8)})</Text>}
        {showThinking && <Text color="gray">  · thinking shown</Text>}
      </Text>
    </Box>
  );
}
