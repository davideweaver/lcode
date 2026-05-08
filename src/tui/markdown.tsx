import { Box, Text } from 'ink';
import type { ReactNode } from 'react';

type InlineSpan =
  | { kind: 'text'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'code'; text: string };

/**
 * Tokenize a single line of markdown into inline spans.
 * Handles **bold**, *italic*, and `code`. Does not nest.
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
    // **bold**
    if (s[i] === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1) {
        flushText();
        out.push({ kind: 'bold', text: s.slice(i + 2, end) });
        i = end + 2;
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
          case 'text':
            return <Text key={i}>{span.text}</Text>;
        }
      })}
    </Text>
  );
}

/**
 * Render multi-line markdown: inline formatting per line, plus
 * fenced code blocks (```) and ATX headings (#, ##, ###).
 */
export function MarkdownText({ children }: { children: string }) {
  const lines = children.split('\n');
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

    // Heading
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      elements.push(
        <Text key={`h-${elements.length}`} color="cyan" bold>
          {heading[2]}
        </Text>,
      );
      i++;
      continue;
    }

    elements.push(<InlineLine key={`l-${elements.length}`} text={line} />);
    i++;
  }

  return <Box flexDirection="column">{elements}</Box>;
}
