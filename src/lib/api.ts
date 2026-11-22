import { sanitizeParams, cleanText, type VisualResult, MAX_REPLY_CHARS } from '../../shared/params';

export interface LlmStatus {
  mode: 'online' | 'offline' | 'disabled' | 'model-missing' | 'unknown';
  model?: string;
}

export async function fetchStatus(refresh = false): Promise<LlmStatus> {
  try {
    const res = await fetch(`/api/llm/status${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) return { mode: 'unknown' };
    const j = (await res.json()) as { mode?: string; model?: string };
    const mode = (['online', 'offline', 'disabled', 'model-missing'] as const).find((m) => m === j.mode) ?? 'unknown';
    return { mode, model: typeof j.model === 'string' ? cleanText(j.model, 60) : undefined };
  } catch {
    return { mode: 'unknown' };
  }
}

export class ApiError extends Error {}

/** Re-validates server output in the browser too (defence in depth). */
function toResult(raw: Record<string, unknown>): VisualResult {
  const { params } = sanitizeParams(raw.params);
  return {
    params,
    reply: cleanText(raw.reply, MAX_REPLY_CHARS),
    source: raw.source === 'llm' ? 'llm' : 'offline',
    notice: raw.notice ? cleanText(raw.notice, 200) : undefined,
  };
}

/**
 * POST /api/visualize?stream=1 and read NDJSON events.
 * Calls onPartial with the (plain text) reply as it streams in.
 */
export async function visualizeStream(
  prompt: string,
  signal: AbortSignal,
  onPartial: (text: string, chars: number) => void,
): Promise<VisualResult> {
  let res: Response;
  try {
    res = await fetch('/api/visualize?stream=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt }),
      signal,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError('Cannot reach the Particle-LM server.');
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status}).`;
    try {
      const j = (await res.json()) as { error?: unknown };
      if (typeof j.error === 'string') msg = cleanText(j.error, 200);
    } catch {
      /* ignore */
    }
    throw new ApiError(msg);
  }
  if (!res.body) throw new ApiError('Empty response.');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'delta') onPartial(cleanText(ev.reply, MAX_REPLY_CHARS), Number(ev.chars) || 0);
      else if (ev.type === 'result') return toResult(ev);
      else if (ev.type === 'error') throw new ApiError(cleanText(ev.message, 200) || 'Request failed.');
    }
  }
  throw new ApiError('The response ended early.');
}
