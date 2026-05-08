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

const MARKER_RE =
  /<\|?(?:channel|message|end|start|analysis|thought|commentary|final|im_start|im_end|tool_call)\|?>/g;

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

/** Longest known marker is ~14 chars; round up for safety. */
const HOLD_BACK = 20;

export class HarmonyNoiseFilter {
  private buf = '';
  private hasEmitted = false;

  /** Feed a streamed chunk; returns the cleaned-and-safe-to-emit prefix. */
  feed(chunk: string): string {
    if (!chunk) return '';
    this.buf += chunk;
    if (this.buf.length <= HOLD_BACK) return '';
    const safeEnd = this.buf.length - HOLD_BACK;
    let safe = this.buf.slice(0, safeEnd);
    this.buf = this.buf.slice(safeEnd);
    safe = safe.replace(MARKER_RE, '');
    if (!this.hasEmitted) {
      safe = safe.replace(LEADING_PARTIAL_CLOSE_RE, '');
    }
    if (safe.length > 0) this.hasEmitted = true;
    return safe;
  }

  /** End-of-stream: emit + clean whatever's left in the hold-back buffer. */
  flush(): string {
    if (!this.buf) return '';
    let out = this.buf;
    out = out.replace(MARKER_RE, '');
    if (!this.hasEmitted) {
      out = out.replace(LEADING_PARTIAL_CLOSE_RE, '');
    }
    out = out.replace(TRAILING_PARTIAL_OPEN_RE, '');
    if (out.length > 0) this.hasEmitted = true;
    this.buf = '';
    return out;
  }
}

/** Convenience for non-streaming use (tests, one-shot calls). */
export function stripHarmonyMarkers(s: string): string {
  return s.replace(MARKER_RE, '');
}
