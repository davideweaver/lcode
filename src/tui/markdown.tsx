import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'link'; text: string; url: string };

/**
 * Tokenize a single line of markdown into inline spans.
 * Handles **bold**, *italic*, `code`, and [text](url) links. Does not nest.
 */
export function parseInline(s: string): InlineSpan[] {
  const out: InlineSpan[] = [];
  let i = 0;
  let textBuf = '';

  const flushText = () => {
    if (textBuf) {
      out.push({ kind: 'text', text: textBuf });
      textBuf = '';
    }
  };

  while (i < s.length) {
    // **bold** / ***bold-italic*** / arbitrary-length asterisk runs.
    // Models occasionally emit 3, 4, or even 5 asterisks on each side; a
    // hard-coded `**` matcher leaks the extras into the span. Match any
    // run of >=2 asterisks and look for a matching trailing run.
    if (s[i] === '*' && s[i + 1] === '*') {
      const leadCount = countAsterisks(s, i);
      const startContent = i + leadCount;
      const trailStart = findAsteriskRun(s, startContent, 2);
      if (trailStart !== -1) {
        flushText();
        out.push({ kind: 'bold', text: s.slice(startContent, trailStart) });
        i = trailStart + countAsterisks(s, trailStart);
        continue;
      }
    }
    // `code`
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      if (end !== -1) {
        flushText();
        out.push({ kind: 'code', text: s.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    // [text](url) link — must have matching closing `]` followed immediately by `(...)`
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1);
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          flushText();
          out.push({
            kind: 'link',
            text: s.slice(i + 1, closeBracket),
            url: s.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }
    // *italic*  (single asterisk, not adjacent to space, not part of **)
    if (s[i] === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ') {
      // search for matching closing `*` not preceded by space and not part of **
      let j = i + 1;
      while (j < s.length) {
        if (s[j] === '*' && s[j - 1] !== ' ' && s[j + 1] !== '*') break;
        j++;
      }
      if (j < s.length) {
        flushText();
        out.push({ kind: 'italic', text: s.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    textBuf += s[i];
    i++;
  }
  flushText();
  return out;
}

/** Count consecutive `*` characters starting at `start`. */
function countAsterisks(s: string, start: number): number {
  let n = 0;
  while (s[start + n] === '*') n++;
  return n;
}

/** Find the next index from `start` where there are >= `min` consecutive
 * `*` characters. Returns -1 if none. */
function findAsteriskRun(s: string, start: number, min: number): number {
  let i = start;
  while (i < s.length) {
    if (s[i] === '*') {
      const n = countAsterisks(s, i);
      if (n >= min) return i;
      i += n;
    } else {
      i++;
    }
  }
  return -1;
}

function InlineLine({ text }: { text: string }) {
  const spans = parseInline(text);
  return (
    <Text>
      {spans.map((span, i) => {
        switch (span.kind) {
          case 'bold':
            return (
              <Text key={i} bold>
                {span.text}
              </Text>
            );
          case 'italic':
            return (
              <Text key={i} italic>
                {span.text}
              </Text>
            );
          case 'code':
            return (
              <Text key={i} color="cyan">
                {span.text}
              </Text>
            );
          case 'link':
            return (
              <Text key={i} color="cyan" underline>
                {span.text}
              </Text>
            );
          case 'text':
            // Safety net: strip orphan `**` runs. If parseInline failed to
            // pair an emphasis run (e.g. due to weirdly-streamed content
            // we haven't seen yet), at least don't render the literal
            // markers to the user. Two-or-more consecutive asterisks have
            // no legitimate prose meaning, so this is safe.
            return <Text key={i}>{stripOrphanStars(span.text)}</Text>;
        }
      })}
    </Text>
  );
}

export function stripOrphanStars(s: string): string {
  return s.replace(/\*{2,}/g, '');
}

/**
 * Heading content is already styled bold/cyan, so emphasis markers inside
 * are redundant and would otherwise render as literal asterisks. Strip
 * any `*`-runs from the captured heading text.
 */
export function stripEmphasisMarkers(s: string): string {
  return s.replace(/\*+/g, '').trim();
}

/**
 * Render multi-line markdown: inline formatting per line, plus
 * fenced code blocks (```) and ATX headings (#, ##, ###).
 */
export function MarkdownText({ children }: { children: string }) {
  const lines = normalizeMd(children).split('\n');
  const elements: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // Fenced code block
    const fenceOpen = line.match(/^```(\w*)\s*$/);
    if (fenceOpen) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? '')) {
        codeLines.push(lines[i] ?? '');
        i++;
      }
      i++; // skip closing fence (or end of input)
      elements.push(
        <Box
          key={`code-${elements.length}`}
          flexDirection="column"
          marginY={0}
          paddingX={1}
          borderStyle="round"
          borderColor="gray"
        >
          {codeLines.map((cl, j) => (
            <Text key={j} color="yellow">
              {cl}
            </Text>
          ))}
        </Box>,
      );
      continue;
    }

    // Heading. Strip emphasis markers from the captured text — the model
    // sometimes emits `## **Title**` (bold inside a heading), and since we
    // already render headings cyan+bold, the inner `**` markers would
    // otherwise show as literal characters.
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      elements.push(
        <Box key={`h-${elements.length}`} marginTop={elements.length > 0 ? 1 : 0}>
          <Text color="cyan" bold>
            {stripEmphasisMarkers(heading[2] ?? '')}
          </Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Bold-only line acts as a soft section header — give it the same
    // top spacing so the model's `**Heading**` style breathes. We accept
    // any run of >=2 asterisks on each side (models sometimes emit 3, 4,
    // even 5) and capture only the inner text.
    const boldOnly = line.match(/^\s*\*{2,}([^*\n]+?)\*{2,}\s*$/);
    if (boldOnly) {
      elements.push(
        <Box key={`bh-${elements.length}`} marginTop={elements.length > 0 ? 1 : 0}>
          <Text color="cyan" bold>
            {boldOnly[1]?.trim()}
          </Text>
        </Box>,
      );
      i++;
      continue;
    }

    // Unordered list: leading whitespace + (* | - | +) + space(s) + content
    const ul = line.match(/^(\s*)([*+\-])\s+(.*)$/);
    if (ul) {
      const indent = (ul[1]?.length ?? 0) + 1;
      elements.push(
        <Box key={`ul-${elements.length}`} marginLeft={indent}>
          <Text color={MD_BULLET}>• </Text>
          <InlineLine text={ul[3] ?? ''} />
        </Box>,
      );
      i++;
      continue;
    }

    // Ordered list: leading whitespace + digits + . + space + content
    const ol = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ol) {
      const indent = ol[1]?.length ?? 0;
      elements.push(
        <Box key={`ol-${elements.length}`} marginLeft={indent}>
          <Text color={MD_BULLET}>{ol[2]}. </Text>
          <InlineLine text={ol[3] ?? ''} />
        </Box>,
      );
      i++;
      continue;
    }

    elements.push(<InlineLine key={`l-${elements.length}`} text={line} />);
    i++;
  }

  return <Box flexDirection="column">{elements}</Box>;
}

const MD_BULLET = 'gray';

/**
 * Normalize Unicode look-alikes that sometimes leak from local LLMs and
 * trip the parser: full-width and operator asterisks become ASCII `*`,
 * non-breaking spaces become regular spaces. Cheap to run and safe — we
 * only touch characters that have a 1:1 ASCII equivalent.
 */
function normalizeMd(s: string): string {
  return s
    .replace(/[＊∗✱∗]/g, '*')
    .replace(/ /g, ' ');
}
