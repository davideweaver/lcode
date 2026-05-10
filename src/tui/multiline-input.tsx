import { Box, Text, useInput, useStdin } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Multiline-capable replacement for ink-text-input.
 *
 * Newline insertion triggers, in priority order:
 *   - A multi-byte stdin chunk that the prependListener recognizes as a
 *     "modified Enter" (Shift/Alt/Ctrl+Enter). Today: `\x1b\r`, `\x1b\n`,
 *     `\x1b[27;2;13~` (xterm modifyOtherKeys), `\x1b[13;2u` (kitty CSI-u).
 *     The terminal opts into emitting these via the modifyOtherKeys mode 1
 *     enable sequence written by app.tsx on mount.
 *   - A bare LF byte (`\n`) — Ctrl+J always sends this, and some terminals
 *     emit it for Shift+Enter when "modify enter" is enabled.
 *   - Backslash + Enter at end of input as a universal fallback.
 *
 * Distinguishing modified Enter from plain Enter has to happen at the raw-byte
 * level: by the time Ink's keypress parser looks at `\x1b\r`, it strips the
 * ESC and dispatches a single event with `input='\r'` and *no* key flags set
 * (not even key.return), so there's nothing to branch on inside useInput.
 *
 * After the prependListener consumes a recognized sequence and inserts `\n`,
 * Ink still dispatches whatever it parsed for that same data chunk — the
 * exact shape varies by sequence and Ink internals. Rather than guessing, we
 * arm a microtask-bounded `consumedRef` gate; both this component's useInput
 * AND the parent app's useInput drop everything while it's set, then it
 * auto-resets before the next data event.
 */
type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  focus?: boolean;
  prompt?: string;
  promptColor?: string;
  /**
   * Set to true by this component when it consumes a "modified Enter"
   * sequence; resets on the next microtask. The parent's `useInput` should
   * drop all events (especially ESC, which would otherwise trigger the
   * double-tap-clear logic) while this is true.
   */
  consumedRef?: React.MutableRefObject<boolean>;
};

export function MultilineInput({
  value,
  onChange,
  onSubmit,
  focus = true,
  prompt = '› ',
  promptColor = 'cyan',
  consumedRef,
}: Props) {
  const [cursor, setCursor] = useState(value.length);

  // When the parent replaces the value externally (history nav, /clear,
  // tab-complete), snap the cursor to the end. Local edits update
  // lastValueRef synchronously inside applyEdit so this effect no-ops.
  const lastValueRef = useRef(value);
  useEffect(() => {
    if (lastValueRef.current !== value) {
      setCursor(value.length);
      lastValueRef.current = value;
    }
  }, [value]);

  const applyEdit = useCallback(
    (next: string, nextCursor: number) => {
      lastValueRef.current = next;
      setCursor(nextCursor);
      onChange(next);
    },
    [onChange],
  );

  const insertAtCursor = useCallback(
    (str: string) => {
      const next = value.slice(0, cursor) + str + value.slice(cursor);
      applyEdit(next, cursor + str.length);
    },
    [value, cursor, applyEdit],
  );

  const localConsumedRef = useRef(false);
  const armConsumed = useCallback(() => {
    localConsumedRef.current = true;
    if (consumedRef) consumedRef.current = true;
    queueMicrotask(() => {
      localConsumedRef.current = false;
      if (consumedRef) consumedRef.current = false;
    });
  }, [consumedRef]);

  const { stdin, isRawModeSupported } = useStdin();
  useEffect(() => {
    if (!focus || !stdin || !isRawModeSupported) return;

    const handler = (data: Buffer) => {
      const str = data.toString();
      if (
        str === '\x1b\r' ||
        str === '\x1b\n' ||
        str === '\x1b[13;2u' ||
        str === '\x1b[27;2;13~'
      ) {
        insertAtCursor('\n');
        armConsumed();
      }
    };

    // prependListener so we run BEFORE Ink's keypress parser. Otherwise Ink
    // dispatches its own events (with unpredictable flag shapes) before we
    // can arm the consumed gate.
    stdin.prependListener('data', handler);
    return () => {
      stdin.off('data', handler);
    };
  }, [focus, stdin, isRawModeSupported, insertAtCursor, armConsumed]);

  useInput(
    (input, key) => {
      if (!focus) return;

      // Drop everything Ink parsed out of the same data chunk we already
      // consumed at the byte level above. Cleared on the next microtask.
      if (localConsumedRef.current) return;

      // Parent owns ESC (cancel turn / double-tap clear) — no-op here.
      if (key.escape) return;

      if (key.return) {
        // Backslash continuation: `\<Enter>` at end of value inserts newline.
        if (cursor === value.length && value.endsWith('\\')) {
          const next = value.slice(0, -1) + '\n';
          applyEdit(next, next.length);
          return;
        }
        onSubmit(value);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursor > 0) {
          const next = value.slice(0, cursor - 1) + value.slice(cursor);
          applyEdit(next, cursor - 1);
        }
        return;
      }

      if (key.leftArrow) {
        if (cursor > 0) setCursor(cursor - 1);
        return;
      }
      if (key.rightArrow) {
        if (cursor < value.length) setCursor(cursor + 1);
        return;
      }

      if (key.upArrow || key.downArrow) {
        // Multi-line vertical nav: only handle when we can actually move
        // within the value. Otherwise let the parent useInput claim arrows
        // for prompt-history / slash-popup nav.
        const lines = value.split('\n');
        if (lines.length <= 1) return;
        const { line, col } = posToLineCol(value, cursor);
        if (key.upArrow) {
          if (line === 0) return;
          const target = lines[line - 1]!;
          const nextCol = Math.min(col, target.length);
          setCursor(lineColToPos(lines, line - 1, nextCol));
        } else {
          if (line === lines.length - 1) return;
          const target = lines[line + 1]!;
          const nextCol = Math.min(col, target.length);
          setCursor(lineColToPos(lines, line + 1, nextCol));
        }
        return;
      }

      // Hand off to parent for slash-popup tab autocomplete and ctrl/meta
      // shortcuts (ctrl+c, ctrl+o, etc.).
      if (key.tab) return;
      if (key.ctrl) return;
      if (key.meta) return;

      if (!input) return;

      // Bare LF (Ctrl+J, or Shift+Enter on terminals that send LF) → newline.
      if (input === '\n') {
        insertAtCursor('\n');
        return;
      }

      insertAtCursor(input);
    },
    { isActive: focus },
  );

  return renderInput(value, cursor, prompt, promptColor, focus);
}

function renderInput(
  value: string,
  cursor: number,
  prompt: string,
  promptColor: string,
  focus: boolean,
): ReactNode {
  const lines = value.split('\n');
  const { line: cursorLine, col: cursorCol } = posToLineCol(value, cursor);
  const continuationIndent = ' '.repeat(prompt.length);
  return (
    <Box flexDirection="column">
      {lines.map((lineText, i) => (
        <Box key={i}>
          <Text color={promptColor}>{i === 0 ? prompt : continuationIndent}</Text>
          <Text>
            {focus && i === cursorLine
              ? renderLineWithCursor(lineText, cursorCol)
              : lineText}
          </Text>
        </Box>
      ))}
    </Box>
  );
}

function renderLineWithCursor(line: string, col: number): ReactNode {
  if (col >= line.length) {
    return (
      <>
        {line}
        <Text inverse> </Text>
      </>
    );
  }
  return (
    <>
      {line.slice(0, col)}
      <Text inverse>{line[col]}</Text>
      {line.slice(col + 1)}
    </>
  );
}

function posToLineCol(value: string, pos: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let i = 0; i < pos; i++) {
    if (value[i] === '\n') {
      line += 1;
      col = 0;
    } else {
      col += 1;
    }
  }
  return { line, col };
}

function lineColToPos(lines: string[], line: number, col: number): number {
  let pos = 0;
  for (let i = 0; i < line; i++) {
    pos += lines[i]!.length + 1;
  }
  return pos + col;
}
