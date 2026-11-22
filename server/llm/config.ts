export interface LlmConfig {
  baseUrl: string;
  fallbackUrl?: string;
  model: string;
  timeoutMs: number;
  offline: boolean;
}

export const DEFAULT_BASE_URL = 'http://192.168.87.10:11434';
export const DEFAULT_MODEL = 'gemma3:12b';

function cleanUrl(v: string | undefined): string | undefined {
  if (!v || !v.trim()) return undefined;
  try {
    const u = new URL(v.trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (u.username || u.password) return undefined; // never accept credentials in URLs
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

export function loadLlmConfig(env: Record<string, string | undefined> = process.env): LlmConfig {
  const timeout = Number(env.LLM_TIMEOUT_MS);
  const baseUrl = cleanUrl(env.LLM_BASE_URL) ?? DEFAULT_BASE_URL;
  const fallbackUrl = cleanUrl(env.LLM_FALLBACK_URL);
  const model = (env.LLM_MODEL ?? '').trim();
  return {
    baseUrl,
    fallbackUrl: fallbackUrl && fallbackUrl !== baseUrl ? fallbackUrl : undefined,
    model: /^[\w.:\-/]{1,100}$/.test(model) ? model : DEFAULT_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 180_000) : 45_000,
    offline: env.LLM_OFFLINE === '1' || env.LLM_OFFLINE === 'true',
  };
}
