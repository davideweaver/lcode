/**
 * Streaming parser that splits text containing `<think>...</think>` tags
 * into separate "text" and "thinking" event streams.
 *
 * Tags can arrive split across SSE chunks (e.g. one chunk ends "abc<thi",
 * next starts "nk>"). The parser holds back any trailing buffer that could
 * be the start of a tag, so emissions are always safe.
 *
 * Used for Qwen3 / DeepSeek-R1 / QwQ-style models that emit reasoning
 * inline as `<think>...</think>` blocks.
 */

export type ParseEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'thinking_start' }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'thinking_stop' };

const OPEN = '<think>';
const CLOSE = '</think>';

export class ThinkingStreamParser {
  private buf = '';
  private inThinking = false;

  /** Feed a streamed chunk and yield any complete events. */
  *feed(chunk: string): Generator<ParseEvent> {
    if (!chunk) return;
    this.buf += chunk;
    yield* this.drain();
  }

  /** End-of-stream: flush any remaining buffer. */
  *flush(): Generator<ParseEvent> {
    if (this.buf.length > 0) {
      yield this.inThinking
        ? { kind: 'thinking_delta', text: this.buf }
        : { kind: 'text_delta', text: this.buf };
      this.buf = '';
    }
    if (this.inThinking) {
      yield { kind: 'thinking_stop' };
      this.inThinking = false;
    }
  }

  private *drain(): Generator<ParseEvent> {
    while (true) {
      const tag = this.inThinking ? CLOSE : OPEN;
      const idx = this.buf.indexOf(tag);
      if (idx === -1) {
        // No tag found yet. Emit everything except a possible partial-tag
        // suffix; keep that in the buffer for the next chunk.
        const hold = longestSuffixThatPrefixes(this.buf, tag);
        const safeLen = this.buf.length - hold;
        if (safeLen > 0) {
          const emit = this.buf.slice(0, safeLen);
          this.buf = this.buf.slice(safeLen);
          yield this.inThinking
            ? { kind: 'thinking_delta', text: emit }
            : { kind: 'text_delta', text: emit };
        }
        return;
      }
      // Found a tag boundary. Emit content before it.
      const before = this.buf.slice(0, idx);
      if (before) {
        yield this.inThinking
          ? { kind: 'thinking_delta', text: before }
          : { kind: 'text_delta', text: before };
      }
      this.buf = this.buf.slice(idx + tag.length);
      // Toggle and announce.
      if (this.inThinking) {
        yield { kind: 'thinking_stop' };
        this.inThinking = false;
      } else {
        yield { kind: 'thinking_start' };
        this.inThinking = true;
      }
    }
  }
}

/**
 * Length of the longest suffix of `s` that is a prefix of `tag`. Used to
 * decide how much trailing buffer to hold back as "could be the start of
 * a tag".
 */
export function longestSuffixThatPrefixes(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let len = max; len > 0; len--) {
    if (s.slice(s.length - len) === tag.slice(0, len)) return len;
  }
  return 0;
}
