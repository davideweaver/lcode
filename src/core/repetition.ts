/**
 * Streaming-degenerate-output detector.
 *
 * Local models occasionally collapse into a verbatim-repetition loop —
 * the same N-character span replays back-to-back until they hit
 * `max_tokens`. We've seen sessions burn 13 minutes producing 32k tokens
 * of two oscillating sentences. The model isn't going to recover, so
 * the only sensible action is to abort the stream.
 *
 * Detection is a sliding check over the tail of accumulated output:
 * for some period L in [minPeriod, maxPeriod], do the last `cycles` * L
 * characters consist of `cycles` identical L-char blocks? If yes, the
 * stream is stuck.
 *
 * Tradeoffs:
 *   - cycles=3 is conservative enough that legitimate prose (parallel
 *     structure, "yes. yes. yes.") rarely trips it but degenerate loops
 *     get caught within ~3 periods.
 *   - minPeriod=40 skips tokenizer-level stutter ("a a a a"), which a
 *     real model recovers from on its own.
 *   - maxPeriod=600 covers the multi-sentence "Wait... Actually..."
 *     oscillation we've observed in practice without scanning the full
 *     buffer for every check.
 */

export interface DetectRepetitionOptions {
  minPeriod?: number;
  maxPeriod?: number;
  cycles?: number;
}

export interface DetectedRepetition {
  period: number;
  cycles: number;
}

const DEFAULT_MIN_PERIOD = 40;
const DEFAULT_MAX_PERIOD = 600;
const DEFAULT_CYCLES = 3;

/**
 * Return the smallest period for which the tail of `text` shows `cycles`
 * consecutive identical blocks, or null if none found within the period
 * window.
 */
export function detectRepetition(
  text: string,
  opts: DetectRepetitionOptions = {},
): DetectedRepetition | null {
  const minPeriod = opts.minPeriod ?? DEFAULT_MIN_PERIOD;
  const maxPeriod = opts.maxPeriod ?? DEFAULT_MAX_PERIOD;
  const cycles = opts.cycles ?? DEFAULT_CYCLES;
  if (cycles < 2) return null;

  const upper = Math.min(maxPeriod, Math.floor(text.length / cycles));
  for (let period = minPeriod; period <= upper; period++) {
    const end = text.length;
    const last = text.slice(end - period, end);
    let ok = true;
    for (let k = 2; k <= cycles; k++) {
      const start = end - period * k;
      if (text.slice(start, start + period) !== last) {
        ok = false;
        break;
      }
    }
    if (ok) return { period, cycles };
  }
  return null;
}

/**
 * Rolling buffer with O(1)-amortized append + periodic detection. Caller
 * feeds chunks of streamed content; once enough has accumulated, `check()`
 * scans the tail for repetition.
 *
 * The buffer is capped so memory stays bounded even when the model is
 * happily producing 100KB+ of legitimate output. The cap is intentionally
 * `cycles * maxPeriod + slop` so the detector still has enough window to
 * see `cycles` worth of any in-range period.
 */
export class RepetitionMonitor {
  private buf: string[] = [];
  private len = 0;
  private readonly cap: number;
  private readonly opts: Required<DetectRepetitionOptions>;
  /** Cheap rate limit on the detector itself (it's O(maxPeriod * cycles)). */
  private checksSinceLastScan = 0;
  /** Don't re-scan after every byte; only every CHECK_INTERVAL chars feed in. */
  private static readonly CHECK_INTERVAL = 200;

  constructor(opts: DetectRepetitionOptions = {}) {
    this.opts = {
      minPeriod: opts.minPeriod ?? DEFAULT_MIN_PERIOD,
      maxPeriod: opts.maxPeriod ?? DEFAULT_MAX_PERIOD,
      cycles: opts.cycles ?? DEFAULT_CYCLES,
    };
    // 2x headroom so the buffer always covers cycles full periods plus
    // some leading context (useful for ad-hoc debugging when a hit fires).
    this.cap = this.opts.maxPeriod * this.opts.cycles * 2;
  }

  feed(chunk: string): void {
    if (!chunk) return;
    this.buf.push(chunk);
    this.len += chunk.length;
    this.checksSinceLastScan += chunk.length;
    if (this.len > this.cap) {
      // Collapse + trim — cheaper than splicing at fragment boundaries.
      const joined = this.buf.join('');
      const trimmed = joined.slice(joined.length - this.cap);
      this.buf = [trimmed];
      this.len = trimmed.length;
    }
  }

  /**
   * Returns the detected repetition, or null. Self-rate-limits — calling
   * after every tiny delta is cheap because the scan is skipped until
   * CHECK_INTERVAL chars have accumulated.
   */
  check(): DetectedRepetition | null {
    if (this.checksSinceLastScan < RepetitionMonitor.CHECK_INTERVAL) return null;
    this.checksSinceLastScan = 0;
    if (this.len < this.opts.minPeriod * this.opts.cycles) return null;
    const tail = this.buf.length === 1 ? this.buf[0]! : this.buf.join('');
    if (this.buf.length > 1) this.buf = [tail];
    return detectRepetition(tail, this.opts);
  }
}
