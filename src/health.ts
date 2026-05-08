import type { LcodeConfig } from './config.js';

export interface HealthResult {
  ok: boolean;
  endpoint: string;
  modelLoaded: string | null;
  modelMatchesConfig: boolean;
  error?: string;
}

export async function probeLlm(
  config: LcodeConfig,
  signal?: AbortSignal,
): Promise<HealthResult> {
  const url = `${config.llmUrl.replace(/\/$/, '')}/v1/models`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal,
    });
    if (!res.ok) {
      return {
        ok: false,
        endpoint: config.llmUrl,
        modelLoaded: null,
        modelMatchesConfig: false,
        error: `HTTP ${res.status}`,
      };
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    const ids = body.data?.map((m) => m.id) ?? [];
    const modelLoaded = ids[0] ?? null;
    return {
      ok: true,
      endpoint: config.llmUrl,
      modelLoaded,
      modelMatchesConfig: ids.includes(config.model),
    };
  } catch (err) {
    return {
      ok: false,
      endpoint: config.llmUrl,
      modelLoaded: null,
      modelMatchesConfig: false,
      error: err instanceof Error ? err.message : String(err),
    };
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
