import { Box, Text } from 'ink';
import { formatTokenCount, tokenStats } from './tokens.js';

interface StatusLineProps {
  folderLabel: string;
  branch: string | null;
  tokensUsed: number;
  /**
   * Whether `tokensUsed` reflects a server-snapped value (true) or only
   * a local-BPE estimate that hasn't been verified yet (false). Right
   * after `--resume` the meter shows "—%" with an empty bar until the
   * first assistant turn re-snaps to ground truth.
   */
  tokensUsedVerified: boolean;
  contextWindow: number;
  sessionId?: string;
  showThinking?: boolean;
}

const BAR_WIDTH = 20;

export function StatusLine({
  folderLabel,
  branch,
  tokensUsed,
  tokensUsedVerified,
  contextWindow,
  sessionId,
  showThinking,
}: StatusLineProps) {
  const stats = tokenStats(tokensUsed, contextWindow);
  const filled = tokensUsedVerified ? Math.round((stats.percent / 100) * BAR_WIDTH) : 0;
  const empty = BAR_WIDTH - filled;
  const barColor =
    stats.percent >= 90 ? 'red' : stats.percent >= 70 ? 'yellow' : 'green';

  return (
    <Box>
      <Text>
        <Text bold>{folderLabel}</Text>
        {branch && <Text color="gray">  ({branch})</Text>}
        <Text>  </Text>
        {tokensUsedVerified && <Text color={barColor}>{'█'.repeat(filled)}</Text>}
        <Text color="gray">{'░'.repeat(empty)}</Text>
        <Text>  </Text>
        {tokensUsedVerified ? (
          <Text color={barColor}>{stats.percent}%</Text>
        ) : (
          <Text color="gray">—%</Text>
        )}
        <Text color="gray">  {formatTokenCount(contextWindow)}</Text>
        {sessionId && <Text color="gray">  ({sessionId.slice(0, 8)})</Text>}
        {showThinking && <Text color="gray">  · thinking shown</Text>}
      </Text>
    </Box>
  );
}
