import { Box, Text, useStdout } from 'ink';

export function Divider() {
  const { stdout } = useStdout();
  const width = (stdout?.columns ?? 80) - 2;
  return (
    <Box>
      <Text dimColor>{'─'.repeat(Math.max(0, width))}</Text>
    </Box>
  );
}
