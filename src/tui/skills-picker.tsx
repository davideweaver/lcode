import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { Skill } from '../skills/types.js';
import { Divider } from './divider.js';

interface SkillsPickerProps {
  skills: Skill[];
  enabled: Set<string>;
  /**
   * Toggle a skill's enabled state. The picker awaits this before flipping
   * the visual state, so callers should persist + lift state in one step.
   */
  onToggle: (name: string) => Promise<void> | void;
  onCancel: () => void;
}

type View =
  | { kind: 'list'; idx: number }
  | { kind: 'detail'; name: string; actionIdx: number };

const PAGE_SIZE = 10;
const BODY_PREVIEW_LINES = 30;

export function SkillsPicker({ skills, enabled, onToggle, onCancel }: SkillsPickerProps) {
  const [view, setView] = useState<View>({ kind: 'list', idx: 0 });

  if (view.kind === 'list') {
    return (
      <SkillListView
        skills={skills}
        enabled={enabled}
        selectedIdx={view.idx}
        onMove={(idx) => setView({ kind: 'list', idx })}
        onPick={(name) => setView({ kind: 'detail', name, actionIdx: 0 })}
        onCancel={onCancel}
      />
    );
  }
  return (
    <SkillDetailView
      skill={skills.find((s) => s.name === view.name)}
      enabled={enabled.has(view.name)}
      actionIdx={view.actionIdx}
      onMoveAction={(actionIdx) => setView({ kind: 'detail', name: view.name, actionIdx })}
      onToggle={() => onToggle(view.name)}
      onBack={() => setView({ kind: 'list', idx: indexOf(skills, view.name) })}
    />
  );
}

function indexOf(skills: Skill[], name: string): number {
  const i = skills.findIndex((s) => s.name === name);
  return i < 0 ? 0 : i;
}

function SkillListView({
  skills,
  enabled,
  selectedIdx,
  onMove,
  onPick,
  onCancel,
}: {
  skills: Skill[];
  enabled: Set<string>;
  selectedIdx: number;
  onMove: (idx: number) => void;
  onPick: (name: string) => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onCancel();
      return;
    }
    if (skills.length === 0) return;
    if (key.upArrow) {
      onMove(Math.max(0, selectedIdx - 1));
      return;
    }
    if (key.downArrow) {
      onMove(Math.min(skills.length - 1, selectedIdx + 1));
      return;
    }
    if (key.return) {
      const picked = skills[selectedIdx];
      if (picked) onPick(picked.name);
    }
  });

  if (skills.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Skills
          </Text>
        </Box>
        <Text color="gray">
          No skills discovered. Drop a SKILL.md into ./.claude/skills/&lt;name&gt;/ or ~/.lcode/skills/&lt;name&gt;/.
        </Text>
        <Box marginTop={1}>
          <Text color="gray">esc to close</Text>
        </Box>
      </Box>
    );
  }

  const nameWidth = Math.max(...skills.map((s) => s.name.length), 6);
  const pageStart = Math.max(
    0,
    Math.min(skills.length - PAGE_SIZE, selectedIdx - Math.floor(PAGE_SIZE / 2)),
  );
  const visible = skills.slice(pageStart, pageStart + PAGE_SIZE);
  const enabledCount = skills.filter((s) => enabled.has(s.name)).length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Skills ({skills.length} discovered, {enabledCount} enabled)
        </Text>
      </Box>
      {visible.map((skill, i) => {
        const idx = pageStart + i;
        const selected = idx === selectedIdx;
        const checked = enabled.has(skill.name);
        const scope = skill.scope.padEnd(7);
        const summary = firstLine(skill.description);
        return (
          <Box key={skill.name}>
            <Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
              </Text>
              <Text color={checked ? 'green' : 'gray'}>{checked ? '✓' : '⊘'} </Text>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {skill.name.padEnd(nameWidth)}
              </Text>
              <Text color="gray">  {scope}  {summary}</Text>
            </Text>
          </Box>
        );
      })}
      {pageStart + visible.length < skills.length && (
        <Box marginTop={1}>
          <Text color="gray">  …{skills.length - pageStart - visible.length} more below</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color="gray">↑↓ navigate · enter for details · esc to close</Text>
      </Box>
    </Box>
  );
}

type SkillAction = 'toggle' | 'back';

function SkillDetailView({
  skill,
  enabled,
  actionIdx,
  onMoveAction,
  onToggle,
  onBack,
}: {
  skill: Skill | undefined;
  enabled: boolean;
  actionIdx: number;
  onMoveAction: (idx: number) => void;
  onToggle: () => void | Promise<void>;
  onBack: () => void;
}) {
  const actions: { id: SkillAction; label: string }[] = [
    { id: 'toggle', label: enabled ? 'Disable' : 'Enable' },
    { id: 'back', label: 'Back' },
  ];

  useInput((_input, key) => {
    if (key.escape || key.leftArrow) {
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
      if (!a) return;
      if (a.id === 'toggle') void onToggle();
      else onBack();
    }
  });

  if (!skill) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color="red">Skill not found.</Text>
        <Box marginTop={1}>
          <Text color="gray">esc to back</Text>
        </Box>
      </Box>
    );
  }

  const bodyLines = skill.body.split('\n');
  const previewLines = bodyLines.slice(0, BODY_PREVIEW_LINES);
  const truncated = bodyLines.length - previewLines.length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {skill.name}
        </Text>
        <Text color={enabled ? 'green' : 'gray'}>  {enabled ? '[enabled]' : '[disabled]'}</Text>
        <Text color="gray">  [{skill.scope} scope]</Text>
      </Box>
      <Field label="Source" value={skill.source} />
      {skill.description && <Field label="Description" value={skill.description} />}
      {skill.whenToUse && <Field label="When to use" value={skill.whenToUse} />}
      {skill.argumentHint && <Field label="Argument hint" value={skill.argumentHint} />}
      {skill.disableModelInvocation && (
        <Field label="Model invoke" value="disabled (user-only)" />
      )}
      <Box marginTop={1} flexDirection="column">
        <Text bold>Body preview:</Text>
        <Divider />
        {previewLines.length === 0 ? (
          <Text color="gray">(empty)</Text>
        ) : (
          previewLines.map((line, i) => (
            <Text key={i} color="gray">{line.length > 0 ? line : ' '}</Text>
          ))
        )}
        {truncated > 0 && <Text color="gray">…{truncated} more line{truncated === 1 ? '' : 's'}</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {actions.map((a, i) => {
          const selected = i === actionIdx;
          return (
            <Text key={a.id}>
              <Text color={selected ? 'cyan' : undefined} bold={selected}>
                {selected ? '› ' : '  '}
                {i + 1}. {a.label}
              </Text>
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

function firstLine(s: string | undefined): string {
  if (!s) return '';
  const idx = s.indexOf('\n');
  const line = idx >= 0 ? s.slice(0, idx) : s;
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
