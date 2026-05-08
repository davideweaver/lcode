import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import type { LcodeConfig } from '../config.js';
import { listAvailableModels } from '../health.js';
import { Divider } from './divider.js';

interface ModelPickerProps {
  config: LcodeConfig;
  currentModel: string;
  onSelect: (model: string) => void;
  onCancel: () => void;
}

const PAGE_SIZE = 10;

export function ModelPicker({ config, currentModel, onSelect, onCancel }: ModelPickerProps) {
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    listAvailableModels(config, ctl.signal)
      .then((ids) => {
        setModels(ids);
        const idx = ids.indexOf(currentModel);
        if (idx >= 0) setSelectedIdx(idx);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    return () => ctl.abort();
  }, [config, currentModel]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (!models || models.length === 0) return;
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(models.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const picked = models[selectedIdx];
      if (picked) onSelect(picked);
    }
  });

  if (error) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">Failed to list models: {error}</Text>
        <Text color="gray">Press Esc to dismiss.</Text>
      </Box>
    );
  }
  if (models === null) {
    return (
      <Box paddingX={1}>
        <Text color="gray">loading models…</Text>
      </Box>
    );
  }
  if (models.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="gray">No models reported by {config.llmUrl}.</Text>
        <Text color="gray">Press Esc to dismiss.</Text>
      </Box>
    );
  }

  const pageStart = Math.max(
    0,
    Math.min(models.length - PAGE_SIZE, selectedIdx - Math.floor(PAGE_SIZE / 2)),
  );
  const visible = models.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text bold color="cyan">
          Select Model ({selectedIdx + 1} of {models.length})
        </Text>
        <Text color="gray">
          current: {currentModel} · endpoint: {config.llmUrl}
        </Text>
        <Text color="gray">↑↓ navigate · enter to select · esc to cancel</Text>
      </Box>
      <Divider />
      {visible.map((name, i) => {
        const idx = pageStart + i;
        const selected = idx === selectedIdx;
        const isCurrent = name === currentModel;
        return (
          <Box key={name} marginTop={i === 0 ? 1 : 0}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {name}
              </Text>
              {isCurrent && <Text color="gray">  (current)</Text>}
            </Text>
          </Box>
        );
      })}
      {pageStart + visible.length < models.length && (
        <Box marginTop={1}>
          <Text color="gray">  …{models.length - pageStart - visible.length} more below</Text>
        </Box>
      )}
    </Box>
  );
}
