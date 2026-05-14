import { Box, Text, useStdout } from 'ink';
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

    // Horizontal rule: a line with only `-`, `*`, or `_` (>=3 of one kind,
    // optionally separated by spaces). Must not contain `|` so we don't
    // swallow a table separator row.
    if (!line.includes('|') && isHorizontalRule(line)) {
      elements.push(<MdDivider key={`hr-${elements.length}`} />);
      i++;
      continue;
    }

    // GFM-style table: header row, then a separator row of `---`/`:---`/
    // `---:`/`:---:` cells, then zero or more data rows.
    const tbl = parseTable(lines, i);
    if (tbl) {
      elements.push(
        <MdTable
          key={`tbl-${elements.length}`}
          header={tbl.header}
          rows={tbl.rows}
          aligns={tbl.aligns}
        />,
      );
      i = tbl.end;
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
  return replaceLatexMath(_normalizeUnicodeLookalikes(s));
}

/**
 * Map of common LaTeX symbol commands (single-token, no arguments) to their
 * Unicode equivalents. Local LLMs trained on math-heavy text often reach for
 * these even in prose — `$\rightarrow$` instead of `→`. We only replace a
 * closed whitelist of recognized names, so unrelated backslash escapes
 * (`\n`, `\t`, path separators) are left alone.
 */
const LATEX_SYMBOLS: Record<string, string> = {
  rightarrow: '→', to: '→', leftarrow: '←', gets: '←',
  Rightarrow: '⇒', Leftarrow: '⇐', implies: '⇒', impliedby: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕',
  Uparrow: '⇑', Downarrow: '⇓',
  mapsto: '↦', hookrightarrow: '↪', hookleftarrow: '↩',
  longrightarrow: '⟶', longleftarrow: '⟵',
  leq: '≤', le: '≤', geq: '≥', ge: '≥',
  neq: '≠', ne: '≠', approx: '≈', sim: '∼', simeq: '≃',
  equiv: '≡', cong: '≅', propto: '∝',
  pm: '±', mp: '∓', times: '×', div: '÷',
  cdot: '·', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙',
  in: '∈', notin: '∉', ni: '∋',
  subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄',
  neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨',
  infty: '∞', ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮',
  partial: '∂', nabla: '∇', surd: '√', angle: '∠',
  prime: '′', therefore: '∴', because: '∵',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ',
  sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};

const LATEX_GLYPH_RE = new RegExp(
  '[' +
    [...new Set(Object.values(LATEX_SYMBOLS))]
      .map((c) => c.replace(/[\\\]^-]/g, '\\$&'))
      .join('') +
    ']',
);

/**
 * Replace LaTeX-style math notation that local LLMs sometimes leak into
 * prose. Two phases:
 *   1. Replace every recognized `\<name>` with its Unicode glyph. The
 *      lookup table is the whitelist — `\n`, `\t`, paths are untouched.
 *   2. Strip `$...$`, `\(...\)`, `\[...\]` delimiters whose inner content
 *      now contains a glyph we inserted and no remaining `\<command>`.
 *      Conservative on `$` so dollar amounts in prose are unaffected.
 */
export function replaceLatexMath(s: string): string {
  const replaced = s.replace(/\\([A-Za-z]+)/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(LATEX_SYMBOLS, name)
      ? LATEX_SYMBOLS[name]!
      : m,
  );
  const stripDelimited = (str: string, re: RegExp): string =>
    str.replace(re, (m: string, inner: string) =>
      LATEX_GLYPH_RE.test(inner) && !/\\[A-Za-z]/.test(inner)
        ? inner.trim()
        : m,
    );
  let out = stripDelimited(replaced, /\$([^$\n]+?)\$/g);
  out = stripDelimited(out, /\\\(([\s\S]*?)\\\)/g);
  out = stripDelimited(out, /\\\[([\s\S]*?)\\\]/g);
  return out;
}

// ---------------------------------------------------------------------------
// Horizontal rule
// ---------------------------------------------------------------------------

/**
 * A markdown horizontal rule is a line containing only `-`, `*`, or `_`
 * characters (at least 3 of a single kind), optionally separated by spaces.
 * Callers must guard against `|` themselves to avoid swallowing table
 * separator rows like `|---|---|`.
 */
export function isHorizontalRule(line: string): boolean {
  const t = line.trim();
  if (t.length < 3) return false;
  if (!/^[-*_\s]+$/.test(t)) return false;
  const compact = t.replace(/\s+/g, '');
  if (compact.length < 3) return false;
  return /^-+$/.test(compact) || /^\*+$/.test(compact) || /^_+$/.test(compact);
}

function MdDivider() {
  const { stdout } = useStdout();
  const width = Math.max(8, (stdout?.columns ?? 80) - 4);
  return (
    <Box marginY={0}>
      <Text dimColor>{'─'.repeat(width)}</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Align = 'left' | 'right' | 'center';

export interface ParsedTable {
  header: string[];
  rows: string[][];
  aligns: Align[];
  end: number;
}

/**
 * Try to parse a GFM-style table starting at `lines[start]`. Returns the
 * parsed table and the index of the first non-table line, or null if the
 * lines don't form a valid table.
 */
export function parseTable(lines: string[], start: number): ParsedTable | null {
  const headerLine = lines[start] ?? '';
  if (!headerLine.includes('|')) return null;
  const sepLine = lines[start + 1] ?? '';
  if (!isTableSeparator(sepLine)) return null;

  const header = splitTableRow(headerLine);
  if (header.length === 0) return null;
  const aligns = splitTableRow(sepLine).map(parseAlign);
  while (aligns.length < header.length) aligns.push('left');

  const rows: string[][] = [];
  let i = start + 2;
  while (i < lines.length) {
    const ln = lines[i] ?? '';
    if (!ln.includes('|')) break;
    if (isTableSeparator(ln)) break;
    if (ln.trim() === '') break;
    rows.push(splitTableRow(ln));
    i++;
  }

  return { header, rows, aligns, end: i };
}

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function parseAlign(sep: string): Align {
  const t = sep.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/**
 * Visible width of a cell as it will render on screen — strips markdown
 * markers we won't actually print (`*`, `` ` ``, `[text](url)` syntax).
 * Used to compute column widths so cells line up after inline formatting.
 */
function visibleCellWidth(s: string): number {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*+/g, '')
    .replace(/`/g, '')
    .length;
}

function MdTable({
  header,
  rows,
  aligns,
}: {
  header: string[];
  rows: string[][];
  aligns: Align[];
}) {
  const cols = header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let max = visibleCellWidth(header[c] ?? '');
    for (const row of rows) max = Math.max(max, visibleCellWidth(row[c] ?? ''));
    widths[c] = max;
  }

  const sepSegments = widths.map((w) => '─'.repeat(w + 2));
  const separator = sepSegments.join('┼');

  return (
    <Box flexDirection="column" marginY={0}>
      <TableRow cells={header} widths={widths} aligns={aligns} bold />
      <Text color="gray">{separator}</Text>
      {rows.map((row, idx) => (
        <TableRow key={idx} cells={row} widths={widths} aligns={aligns} />
      ))}
    </Box>
  );
}

function TableRow({
  cells,
  widths,
  aligns,
  bold,
}: {
  cells: string[];
  widths: number[];
  aligns: Align[];
  bold?: boolean;
}) {
  return (
    <Box>
      {widths.map((w, i) => (
        <Box key={i}>
          {i === 0 ? <Text>{' '}</Text> : <Text color="gray">{' │ '}</Text>}
          <PaddedCell
            text={cells[i] ?? ''}
            width={w}
            align={aligns[i] ?? 'left'}
            bold={bold}
          />
          {i === widths.length - 1 ? <Text>{' '}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

function PaddedCell({
  text,
  width,
  align,
  bold,
}: {
  text: string;
  width: number;
  align: Align;
  bold?: boolean;
}) {
  const vw = visibleCellWidth(text);
  const pad = Math.max(0, width - vw);
  let leftPad = '';
  let rightPad = '';
  if (align === 'right') leftPad = ' '.repeat(pad);
  else if (align === 'center') {
    leftPad = ' '.repeat(Math.floor(pad / 2));
    rightPad = ' '.repeat(Math.ceil(pad / 2));
  } else rightPad = ' '.repeat(pad);

  return (
    <Text bold={bold}>
      {leftPad}
      <InlineLine text={text} />
      {rightPad}
    </Text>
  );
}

function _normalizeUnicodeLookalikes(s: string): string {
  return s
    .replace(/[＊∗✱∗]/g, '*')
    .replace(/ /g, ' ');
}
