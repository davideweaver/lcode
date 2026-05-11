import type { LcodeConfig } from './config.js';

export interface HealthResult {
  ok: boolean;
  endpoint: string;
  modelLoaded: string | null;
  modelMatchesConfig: boolean;
  /**
   * Live context window reported by the LLM server (llama.cpp `/props`),
   * or null if the server doesn't expose it. The TUI prefers this over the
   * static `LCODE_CONTEXT_WINDOW` config so the meter reflects the actual
   * loaded `n_ctx`.
   */
  contextWindow: number | null;
  error?: string;
}

export async function probeLlm(
  config: LcodeConfig,
  signal?: AbortSignal,
  /**
   * Model to probe `/props` for. Defaults to `config.model`. The TUI passes
   * the live `currentModel` so switching models in the picker re-probes the
   * matching backend.
   */
  model?: string,
): Promise<HealthResult> {
  const base = config.llmUrl.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${config.apiKey}` };
  const probedModel = model ?? config.model;
  try {
    const [modelsRes, contextWindow] = await Promise.all([
      fetch(`${base}/v1/models`, { headers, signal }),
      probeContextWindow(base, probedModel, headers, signal),
    ]);
    if (!modelsRes.ok) {
      return {
        ok: false,
        endpoint: config.llmUrl,
        modelLoaded: null,
        modelMatchesConfig: false,
        contextWindow,
        error: `HTTP ${modelsRes.status}`,
      };
    }
    const body = (await modelsRes.json()) as { data?: Array<{ id: string }> };
    const ids = body.data?.map((m) => m.id) ?? [];
    const modelLoaded = ids[0] ?? null;
    return {
      ok: true,
      endpoint: config.llmUrl,
      modelLoaded,
      modelMatchesConfig: ids.includes(config.model),
      contextWindow,
    };
  } catch (err) {
    return {
      ok: false,
      endpoint: config.llmUrl,
      modelLoaded: null,
      modelMatchesConfig: false,
      contextWindow: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Read the live context window for `model` from whichever backend the
 * endpoint speaks. Returns null on any failure — the caller falls back to
 * config.
 *
 * - llama.cpp / llamacpp-router: `/props` exposes the loaded slot's
 *   `n_ctx`. The `?model=` query is honored by the router proxy; raw
 *   llama.cpp ignores it.
 * - omlx: `/v1/models/status` returns a `models[]` array with each entry's
 *   `max_context_window`.
 */
async function probeContextWindow(
  base: string,
  model: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<number | null> {
  return (
    (await probeLlamaProps(base, model, headers, signal)) ??
    (await probeOmlxStatus(base, model, headers, signal))
  );
}

async function probeLlamaProps(
  base: string,
  model: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const url = `${base}/props?model=${encodeURIComponent(model)}`;
    const res = await fetch(url, { headers, signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      default_generation_settings?: { n_ctx?: number };
      n_ctx?: number;
    };
    const n = body.default_generation_settings?.n_ctx ?? body.n_ctx;
    return typeof n === 'number' && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function probeOmlxStatus(
  base: string,
  model: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(`${base}/v1/models/status`, { headers, signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      models?: Array<{ id?: string; max_context_window?: number }>;
    };
    const entry = body.models?.find((m) => m.id === model);
    const n = entry?.max_context_window;
    return typeof n === 'number' && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function listAvailableModels(
  config: LcodeConfig,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `${config.llmUrl.replace(/\/$/, '')}/v1/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string }> };
  return body.data?.map((m) => m.id) ?? [];
}
