/**
 * Streaming filter that strips Harmony-format channel markers from text
 * deltas. Used as a defensive layer in front of the inline `<think>`
 * parser, since some models (gemma4 community quants, GPT-OSS variants)
 * leak markers like `<|channel|>thought<|message|>` as plain text when
 * the chat template doesn't post-process them.
 *
 * We hold back the last `HOLD_BACK` chars of the buffer per `feed()` so
 * markers split across SSE chunks still get caught. The held tail is
 * flushed (and stripped) on stream end.
 */

/**
 * Structural markers — appear inside `<|...|>` to delimit Harmony sections.
 */
const STRUCTURAL_MARKERS = [
  'channel',
  'message',
  'end',
  'start',
  'im_start',
  'im_end',
  'tool_call',
];

/**
 * Channel names — appear as bare words AFTER `<|channel|>` to label a
 * channel. Kept narrow so we don't strip "end" or "start" as if they were
 * channel names when they appear as normal content elsewhere.
 */
const CHANNEL_NAMES = ['analysis', 'final', 'commentary', 'thought'];

const MARKER_KEYWORDS = [...STRUCTURAL_MARKERS, ...CHANNEL_NAMES];

const MARKER_RE = new RegExp(
  `<\\|?(?:${MARKER_KEYWORDS.join('|')})\\|?>`,
  'g',
);

/**
 * Channel directive: `<|channel|>name` plus trailing whitespace. The name
 * is part of the directive syntax, not user content — strip them as one
 * unit. We restrict the name to the conservative CHANNEL_NAMES list so we
 * don't accidentally eat normal sentences after `<channel|>`.
 */
const CHANNEL_DIRECTIVE_RE = new RegExp(
  `<\\|?channel\\|?>\\s*(?:${CHANNEL_NAMES.join('|')})\\s*`,
  'g',
);

/**
 * Trailing partial open: e.g. `…<|channe` left in the buffer when a stream
 * ends mid-marker. We strip the dangling fragment rather than emitting it.
 */
const TRAILING_PARTIAL_OPEN_RE = /<\|?[a-zA-Z_]*$/;

/**
 * Leading partial close: e.g. `l>thought…` at the start of a NEXT turn,
 * when the previous turn ended mid-marker (we already lost the open). At
 * least one alpha char before `>` (or `|>`) so we don't strip stray `>`s
 * or normal `5 > 3` text.
 */
const LEADING_PARTIAL_CLOSE_RE = /^[a-zA-Z_]+\|?>/;

export class HarmonyNoiseFilter {
  private buf = '';
  private hasEmitted = false;

  /** Feed a streamed chunk; returns the cleaned-and-safe-to-emit prefix. */
  feed(chunk: string): string {
    if (!chunk) return '';
    this.buf += chunk;
    return this.drain(false);
  }

  /** End-of-stream: emit + clean whatever's left in the buffer. */
  flush(): string {
    return this.drain(true);
  }

  /**
   * Compute the safe-to-emit portion. We hold back any tail that begins
   * with `<` and could still be the start of a marker (no `>` seen yet).
   * Fixed hold-back is wrong because markers can land mid-buffer; the
   * boundary must be marker-aware.
   */
  private drain(isFinal: boolean): string {
    if (this.buf.length === 0) return '';
    let safeEnd = this.buf.length;
    if (!isFinal) {
      safeEnd = computeSafeEnd(this.buf);
    }
    if (safeEnd === 0) return '';
    let safe = this.buf.slice(0, safeEnd);
    this.buf = this.buf.slice(safeEnd);
    // Channel directives MUST be stripped before bare markers — otherwise
    // `<|channel|>thought<|channel|>` becomes `thought` instead of empty.
    safe = safe.replace(CHANNEL_DIRECTIVE_RE, '');
    safe = safe.replace(MARKER_RE, '');
    if (isFinal) {
      // Drop dangling `<|chan` etc. that never closed.
      safe = safe.replace(TRAILING_PARTIAL_OPEN_RE, '');
    }
    if (!this.hasEmitted) {
      safe = safe.replace(LEADING_PARTIAL_CLOSE_RE, '');
    }
    if (safe.length > 0) this.hasEmitted = true;
    return safe;
  }
}

const TRAILING_DIRECTIVE_OPEN_RE = /<\|?channel\|?>[a-zA-Z_]*$/;

const TRAILING_COMPLETE_MARKER_RE = new RegExp(
  `<\\|?(?:${MARKER_KEYWORDS.join('|')})\\|?>$`,
);

/**
 * Decide where it's safe to emit. Three deferral rules, applied in order:
 *
 *   1. Trailing partial open marker (`…<|chan` with no `>` yet).
 *   2. Trailing channel directive that may still be receiving its name
 *      (`…<|channel|>th` where the next chunk may complete `thought`).
 *      This is critical: without it, an SSE boundary inside the channel
 *      name lets `<|channel|>` get stripped early as a bare marker, then
 *      the orphaned name leaks as content in the next chunk.
 *   3. Trailing complete marker (`…<|end|>`) — defer in case it's the
 *      start of a directive whose name lives in the next chunk.
 */
function computeSafeEnd(buf: string): number {
  const lastOpen = buf.lastIndexOf('<');
  if (lastOpen !== -1) {
    const closeAfter = buf.indexOf('>', lastOpen);
    if (closeAfter === -1) {
      const tail = buf.slice(lastOpen);
      if (couldBeMarkerStart(tail)) return lastOpen;
    }
  }
  const directiveOpen = buf.match(TRAILING_DIRECTIVE_OPEN_RE);
  if (directiveOpen) return buf.length - directiveOpen[0].length;
  const completeMarker = buf.match(TRAILING_COMPLETE_MARKER_RE);
  if (completeMarker) return buf.length - completeMarker[0].length;
  return buf.length;
}

/**
 * Returns true if `s` (which starts with `<`) might still resolve to a
 * marker once more chars arrive. Used to decide whether to hold back a
 * partial-marker tail or emit it as plain text.
 */
function couldBeMarkerStart(s: string): boolean {
  if (s.length === 1) return true; // just `<` — wait for next chunk
  if (s[1] === '|') return true; // `<|...` is the strong marker shape
  const m = s.slice(1).match(/^([a-zA-Z_]+)/);
  if (!m) return false; // `< 5`, `< foo`, etc. — not a marker
  const word = m[1]!.toLowerCase();
  return MARKER_KEYWORDS.some((k) => k.startsWith(word) || word.startsWith(k));
}

/** Convenience for non-streaming use (tests, one-shot calls). */
export function stripHarmonyMarkers(s: string): string {
  return s.replace(MARKER_RE, '');
}
