import { sanitizeParams, cleanText, type VisualResult, MAX_REPLY_CHARS } from '../../shared/params';

import { STATUS_MODES, type LlmStatus } from './status';

export type { LlmStatus } from './status';

export async function fetchStatus(refresh = false): Promise<LlmStatus> {
  try {
    const res = await fetch(`/api/llm/status${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' });
    if (!res.ok) return { mode: 'unknown' };
    const j = (await res.json()) as { mode?: string; model?: string; primary?: string; notice?: string };
    const mode = STATUS_MODES.find((m) => m === j.mode) ?? 'unknown';
    const primary = (['ok', 'stalled', 'down', 'unknown'] as const).find((p) => p === j.primary);
    return {
      mode,
      model: typeof j.model === 'string' ? cleanText(j.model, 60) : undefined,
      primary,
      notice: j.notice ? cleanText(j.notice, 200) : undefined,
    };
  } catch {
    return { mode: 'unknown' };
  }
}

export const BUSY_MESSAGE = 'The local LLM is busy right now. Try again in a moment.';

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
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
  let res: Response | undefined;
  // One quiet retry on 429 (e.g. a double tap while the server frees the previous slot).
  for (let attempt = 0; attempt < 2; attempt++) {
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
    if (res.status !== 429) break;
    if (attempt === 0) {
      res.body?.cancel().catch(() => undefined);
      await wait(600, signal);
    }
  }
  if (!res) throw new ApiError('Cannot reach the Particle-LM server.');
  if (res.status === 429) {
    res.body?.cancel().catch(() => undefined);
    throw new ApiError(BUSY_MESSAGE);
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
      else if (ev.type === 'result') {
        // Drain the rest of the stream so DevTools doesn't log the request as aborted.
        while (!(await reader.read()).done) {
          /* drain */
        }
        return toResult(ev);
      }
      else if (ev.type === 'error') throw new ApiError(cleanText(ev.message, 200) || 'Request failed.');
    }
  }
  throw new ApiError('The response ended early.');
}
