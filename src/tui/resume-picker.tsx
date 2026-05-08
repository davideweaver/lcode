import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import {
  formatBytes,
  listSessions,
  relativeTime,
  type SessionSummary,
} from '../core/sessions.js';
import { Divider } from './divider.js';

interface ResumePickerProps {
  cwd: string;
  onSelect: (summary: SessionSummary) => void;
  onCancel: () => void;
}

const PAGE_SIZE = 10;

export function ResumePicker({ cwd, onSelect, onCancel }: ResumePickerProps) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);

  useEffect(() => {
    listSessions(cwd)
      .then((s) => setSessions(s))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [cwd]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (!sessions || sessions.length === 0) return;
    if (key.upArrow) {
      setSelectedIdx((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIdx((i) => Math.min(sessions.length - 1, i + 1));
      return;
    }
    if (key.return) {
      const picked = sessions[selectedIdx];
      if (picked) onSelect(picked);
    }
  });

  if (error) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">Failed to list sessions: {error}</Text>
        <Text dimColor>Press Esc to dismiss.</Text>
      </Box>
    );
  }
  if (sessions === null) {
    return (
      <Box paddingX={1}>
        <Text dimColor>loading sessions…</Text>
      </Box>
    );
  }
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>No saved sessions in this directory yet.</Text>
        <Text dimColor>Press Esc to dismiss.</Text>
      </Box>
    );
  }

  // Window the visible page so navigation always keeps the highlight in view.
  const pageStart = Math.max(0, Math.min(sessions.length - PAGE_SIZE, selectedIdx - Math.floor(PAGE_SIZE / 2)));
  const visible = sessions.slice(pageStart, pageStart + PAGE_SIZE);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Resume Session ({selectedIdx + 1} of {sessions.length})
        </Text>
        <Text dimColor>   ↑↓ navigate · enter to resume · esc to cancel</Text>
      </Box>
      <Divider />
      {visible.map((s, i) => {
        const idx = pageStart + i;
        const selected = idx === selectedIdx;
        return (
          <Box key={s.sessionId} flexDirection="column" marginTop={i === 0 ? 1 : 0}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {s.title}
              </Text>
            </Text>
            <Text>
              <Text dimColor>
                {'    '}
                {relativeTime(s.modifiedMs)} · {s.turns} turn
                {s.turns === 1 ? '' : 's'} · {formatBytes(s.sizeBytes)} · {s.sessionId.slice(0, 8)}
              </Text>
            </Text>
          </Box>
        );
      })}
      {pageStart + visible.length < sessions.length && (
        <Box marginTop={1}>
          <Text dimColor>  …{sessions.length - pageStart - visible.length} more below</Text>
        </Box>
      )}
    </Box>
  );
}
