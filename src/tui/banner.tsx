import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';
import { homedir } from 'node:os';
import type { LcodeConfig } from '../config.js';
import type { HealthResult } from '../health.js';

const VERSION = '0.0.1';

interface BannerProps {
  config: LcodeConfig;
  cwd: string;
  /**
   * Probe result, or null while still in flight. When null the model
   * line gets an animated spinner; once resolved the App pushes a final
   * Banner into <Static> so the badge persists in scrollback.
   */
  health: HealthResult | null;
}

/**
 * Three-line startup banner.
 *
 *   <name> v<version>
 *   <model> · <endpoint>  <badge>
 *   <cwd-with-tilde>
 *
 * Rendered live (with spinner) until the health probe resolves, then
 * re-rendered once into <Static> with a final ✓/⚠/✗ badge.
 */
export function Banner({ config, cwd, health }: BannerProps) {
  const home = homedir();
  const displayPath =
    cwd === home
      ? '~'
      : cwd.startsWith(home + '/')
        ? '~' + cwd.slice(home.length)
        : cwd;

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text bold>lcode</Text> <Text dimColor>v{VERSION}</Text>
      </Text>
      <Text>
        <Text color="gray">{config.model} · {config.llmUrl}</Text>
        {health === null ? (
          <ProbingBadge />
        ) : (
          <HealthBadge health={health} configuredModel={config.model} />
        )}
      </Text>
      <Text color="gray">{displayPath}</Text>
    </Box>
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function ProbingBadge() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      80,
    );
    return () => clearInterval(id);
  }, []);
  return <Text color="cyan">  {SPINNER_FRAMES[frame]}</Text>;
}

function HealthBadge({
  health,
  configuredModel,
}: {
  health: HealthResult;
  configuredModel: string;
}) {
  if (!health.ok) {
    return <Text color="red">  ✗ {health.error ?? 'unreachable'}</Text>;
  }
  if (!health.modelMatchesConfig) {
    const loaded = health.modelLoaded ? ` (loaded: ${health.modelLoaded})` : '';
    return (
      <Text color="yellow">
        {`  ⚠ "${configuredModel}" not loaded${loaded}`}
      </Text>
    );
  }
  return <Text color="green">  ✓</Text>;
}
