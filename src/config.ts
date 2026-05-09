import 'dotenv/config';

export interface LcodeConfig {
  llmUrl: string;
  model: string;
  apiKey: string;
  /** Context window in tokens. Used to compute the statusline percentage. */
  contextWindow: number;
  /**
   * Fraction of contextWindow at which auto-compaction triggers. Values
   * close to 1.0 wait until the prompt is nearly full; lower values
   * compact earlier with more headroom. Clamped to (0, 1].
   */
  compactThreshold: number;
  /**
   * SearXNG base URL used by the WebSearch tool. Empty string disables
   * WebSearch — the tool errors with a setup hint when invoked.
   */
  searxngUrl: string;
}

export function loadConfig(): LcodeConfig {
  const rawThreshold = parseFloat(process.env.LCODE_COMPACT_THRESHOLD ?? '0.75');
  const compactThreshold = Number.isFinite(rawThreshold) && rawThreshold > 0 && rawThreshold <= 1
    ? rawThreshold
    : 0.75;
  return {
    llmUrl: normalizeBaseUrl(process.env.LCODE_LLM_URL ?? 'http://llm.appkit.local:9100/v1'),
    model: process.env.LCODE_MODEL ?? 'gemma4',
    apiKey: process.env.LCODE_API_KEY ?? 'sk-not-needed',
    contextWindow: parseInt(process.env.LCODE_CONTEXT_WINDOW ?? '32768', 10),
    compactThreshold,
    searxngUrl: (process.env.LCODE_SEARXNG_URL ?? 'http://172.16.0.14:3274').replace(/\/+$/, ''),
  };
}

/**
 * Strip trailing slash and a trailing /v1 (or /v1/) so that callers can pass
 * either form of base URL. lcode appends /v1/... itself.
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}
