import 'dotenv/config';

export interface LcodeConfig {
  llmUrl: string;
  model: string;
  apiKey: string;
  /** Context window in tokens. Used to compute the statusline percentage. */
  contextWindow: number;
}

export function loadConfig(): LcodeConfig {
  return {
    llmUrl: normalizeBaseUrl(process.env.LCODE_LLM_URL ?? 'http://llm.appkit.local:9100/v1'),
    model: process.env.LCODE_MODEL ?? 'gemma4',
    apiKey: process.env.LCODE_API_KEY ?? 'sk-not-needed',
    contextWindow: parseInt(process.env.LCODE_CONTEXT_WINDOW ?? '32768', 10),
  };
}

/**
 * Strip trailing slash and a trailing /v1 (or /v1/) so that callers can pass
 * either form of base URL. lcode appends /v1/... itself.
 */
export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}
