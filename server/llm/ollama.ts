/**
 * Minimal Ollama provider (local only). Talks to /api/tags and /api/chat.
 * Never sends keep_alive, never pulls/loads/unloads models explicitly,
 * never includes the upstream URL in errors that reach the browser.
 */
import type { LlmConfig } from './config.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LlmErrorCode = 'unreachable' | 'timeout' | 'bad_status' | 'model_missing' | 'aborted' | 'bad_output';

export type LlmErrorReason = 'truncated' | 'think_unsupported' | 'stalled';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly reason?: LlmErrorReason;
  constructor(code: LlmErrorCode, message: string, reason?: LlmErrorReason) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.reason = reason;
  }
}

interface StreamLine {
  message?: { content?: string; thinking?: string };
  error?: string;
  done?: boolean;
  done_reason?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  format?: unknown;
  signal?: AbortSignal;
  onDelta?: (chunk: string, total: string) => void;
  temperature?: number;
  maxTokens?: number;
}

interface StreamState {
  total: string;
  doneReason?: string;
}

export interface ChatResult {
  text: string;
  via: 'primary' | 'fallback';
  ms: number;
}

export type EndpointHealth = 'ok' | 'stalled' | 'down' | 'unknown';

export interface LlmStatus {
  reachable: boolean;
  modelInstalled: boolean;
  /** Endpoint that answered most recently (probe or chat). */
  via: 'primary' | 'fallback' | null;
  primary: EndpointHealth;
  /** Result of the most recent chat, if within the last few minutes. */
  lastChat: 'ok' | 'failed' | null;
}

const RECENT_MS = 3 * 60_000;

export class OllamaProvider {
  private readonly cfg: LlmConfig;
  private readonly fetchImpl: FetchLike;
  private probeCache: { at: number; value: Omit<LlmStatus, 'lastChat'> } | null = null;
  /** Health observed by real chat traffic (overrides an older probe). */
  private observed: { at: number; via: 'primary' | 'fallback' | null; primary: EndpointHealth; ok: boolean } | null = null;

  constructor(cfg: LlmConfig, fetchImpl: FetchLike = (i, init) => fetch(i, init)) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
  }

  get model(): string {
    return this.cfg.model;
  }

  private endpoints(): Array<{ url: string; via: 'primary' | 'fallback' }> {
    const list: Array<{ url: string; via: 'primary' | 'fallback' }> = [{ url: this.cfg.baseUrl, via: 'primary' }];
    if (this.cfg.fallbackUrl) list.push({ url: this.cfg.fallbackUrl, via: 'fallback' });
    return list;
  }

  /**
   * Chat order: if the primary was seen stalled/down in the last 30 s (by a chat or a probe), try the
   * fallback first so every prompt doesn't pay the connect timeout. A later probe that finds the primary
   * healthy restores the normal order.
   */
  private chatEndpoints(): Array<{ url: string; via: 'primary' | 'fallback' }> {
    const list = this.endpoints();
    if (list.length < 2) return list;
    const now = Date.now();
    const probe = this.probeCache;
    const obs = this.observed;
    const latest =
      obs && (!probe || obs.at >= probe.at) ? { at: obs.at, primary: obs.primary } : probe ? { at: probe.at, primary: probe.value.primary } : null;
    if (latest && now - latest.at < 30_000 && (latest.primary === 'stalled' || latest.primary === 'down')) {
      return [list[1], list[0]];
    }
    return list;
  }

  /** True if a forced refresh is allowed (cheap guard against probe spam). */
  canRefresh(): boolean {
    return !this.probeCache || Date.now() - this.probeCache.at > 3000;
  }

  /**
   * Read-only health: GET /api/tags on each endpoint (cached 15 s), merged with what
   * the most recent chat actually experienced, so the UI never shows green when chat failed.
   */
  async status(force = false): Promise<LlmStatus> {
    if (force && !this.canRefresh()) force = false;
    if (force || !this.probeCache || Date.now() - this.probeCache.at > 15_000) {
      let value: Omit<LlmStatus, 'lastChat'> = { reachable: false, modelInstalled: false, via: null, primary: 'unknown' };
      for (const ep of this.endpoints()) {
        const timeout = AbortSignal.timeout(this.cfg.tagsTimeoutMs);
        try {
          const res = await this.fetchImpl(`${ep.url}/api/tags`, { signal: timeout });
          if (!res.ok) {
            if (ep.via === 'primary') value.primary = 'down';
            continue;
          }
          const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
          const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean) as string[];
          value = {
            reachable: true,
            modelInstalled: names.includes(this.cfg.model),
            via: ep.via,
            primary: ep.via === 'primary' ? 'ok' : value.primary,
          };
          break;
        } catch {
          if (ep.via === 'primary') value.primary = timeout.aborted ? 'stalled' : 'down';
        }
      }
      this.probeCache = { at: Date.now(), value };
    }
    const probe = this.probeCache!.value;
    const obs = this.observed && Date.now() - this.observed.at < RECENT_MS ? this.observed : null;
    // Prefer the newer of probe vs observed chat.
    if (obs && obs.at >= this.probeCache!.at) {
      return {
        reachable: obs.ok ? true : probe.reachable,
        modelInstalled: obs.ok ? true : probe.modelInstalled,
        via: obs.ok ? obs.via : probe.via,
        primary: obs.primary,
        lastChat: obs.ok ? 'ok' : 'failed',
      };
    }
    return { ...probe, lastChat: obs ? (obs.ok ? 'ok' : 'failed') : null };
  }

  /**
   * Streams a chat completion from POST /api/chat.
   * Fallback rules: an endpoint that refuses the connection, or accepts it but sends no response
   * headers within LLM_CONNECT_TIMEOUT_MS, is skipped for the next one. Once headers/stream data
   * arrived, failures are final (no fallback). LLM_TIMEOUT_MS is one budget across all endpoints.
   */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    const deadline = started + this.cfg.timeoutMs;
    let lastErr: LlmError = new LlmError('unreachable', 'Local LLM is unreachable.');
    const order = this.chatEndpoints();
    // If we skip straight to the fallback, carry the known primary health forward.
    let primary: EndpointHealth = order[0].via === 'fallback' ? (this.observed?.primary ?? this.probeCache?.value.primary ?? 'unknown') : 'unknown';
    for (const ep of order) {
      if (opts.signal?.aborted) throw new LlmError('aborted', 'Request cancelled.');
      if (Date.now() >= deadline) {
        lastErr = new LlmError('timeout', 'Local LLM timed out.');
        break;
      }
      try {
        let text: string;
        try {
          text = await this.chatOnce(ep.url, messages, opts, this.cfg.think, deadline);
        } catch (err) {
          // Older Ollama builds reject `think` on non-thinking models: retry once without the field.
          if (err instanceof LlmError && err.reason === 'think_unsupported' && this.cfg.think !== undefined) {
            text = await this.chatOnce(ep.url, messages, opts, undefined, deadline);
          } else throw err;
        }
        if (ep.via === 'primary') primary = 'ok';
        this.observed = { at: Date.now(), via: ep.via, primary, ok: true };
        return { text, via: ep.via, ms: Date.now() - started };
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('unreachable', 'Local LLM is unreachable.');
        if (e.code === 'aborted') throw e;
        if (ep.via === 'primary') primary = e.reason === 'stalled' ? 'stalled' : e.code === 'unreachable' ? 'down' : 'ok';
        if (e.code !== 'unreachable') {
          // Reached a server that then failed (HTTP error, bad output, overall timeout): final.
          this.observed = { at: Date.now(), via: ep.via, primary, ok: e.code === 'bad_output' };
          throw e;
        }
        lastErr = e;
      }
    }
    this.observed = { at: Date.now(), via: null, primary, ok: false };
    throw lastErr;
  }

  private async chatOnce(
    baseUrl: string,
    messages: ChatMessage[],
    opts: ChatOptions,
    think: boolean | undefined,
    deadline: number,
  ): Promise<string> {
    const overall = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const connect = new AbortController();
    const connectTimer = setTimeout(() => connect.abort(), Math.min(this.cfg.connectTimeoutMs, Math.max(1, deadline - Date.now())));
    const signals = [overall, connect.signal];
    if (opts.signal) signals.push(opts.signal);
    const signal = AbortSignal.any(signals);
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages,
      stream: true,
      format: opts.format ?? 'json',
      options: { temperature: opts.temperature ?? 0.6, num_predict: opts.maxTokens ?? this.cfg.numPredict },
    };
    if (think !== undefined) body.think = think;

    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      clearTimeout(connectTimer);
      throw this.classify(err, opts.signal, overall, connect.signal);
    }
    // Headers arrived: the connect/first-byte window is over; only the overall budget applies now.
    clearTimeout(connectTimer);

    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      if (res.status === 400 && think !== undefined && /think/i.test(detail)) {
        throw new LlmError('bad_status', 'Local LLM rejected the think option.', 'think_unsupported');
      }
      if (res.status === 404 || /not found/i.test(detail)) {
        throw new LlmError('model_missing', 'The configured model is not installed on the LLM host.');
      }
      throw new LlmError('bad_status', `Local LLM returned HTTP ${res.status}.`);
    }
    if (!res.body) throw new LlmError('bad_output', 'Local LLM returned an empty body.');

    const state: StreamState = { total: '' };
    let buf = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    // Abort (cancel / supersede / overall timeout) must stop the stream even if the body ignores the signal.
    const stopOnAbort = () => reader.cancel().catch(() => undefined);
    signal.addEventListener('abort', stopOnAbort, { once: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          this.handleLine(line, state, opts);
        }
      }
      const tail = buf.trim();
      if (tail) this.handleLine(tail, state, opts);
    } catch (err) {
      reader.cancel().catch(() => undefined);
      if (err instanceof LlmError) throw err;
      const e = this.classify(err, opts.signal, overall, undefined);
      // A failure after the response started is not a connection failure: don't fall back.
      throw e.code === 'unreachable' ? new LlmError('bad_output', 'Local LLM stream was interrupted.') : e;
    } finally {
      signal.removeEventListener('abort', stopOnAbort);
      reader.releaseLock();
    }
    if (state.doneReason === 'length') {
      throw new LlmError('bad_output', 'Local LLM output was cut off.', 'truncated');
    }
    return state.total;
  }

  private handleLine(line: string, state: StreamState, opts: ChatOptions): void {
    let msg: StreamLine;
    try {
      msg = JSON.parse(line);
    } catch {
      throw new LlmError('bad_output', 'Local LLM sent malformed stream data.');
    }
    if (msg.error) {
      if (/not found/i.test(msg.error)) throw new LlmError('model_missing', 'The configured model is not installed on the LLM host.');
      throw new LlmError('bad_output', 'Local LLM reported an error.');
    }
    if (msg.done && msg.done_reason) state.doneReason = msg.done_reason;
    // Only `content` is answer text; `message.thinking` (reasoning models) is ignored.
    const chunk = typeof msg.message?.content === 'string' ? msg.message.content : '';
    if (chunk) {
      state.total += chunk;
      opts.onDelta?.(chunk, state.total);
    }
  }

  private classify(
    err: unknown,
    caller: AbortSignal | undefined,
    overall: AbortSignal,
    connect: AbortSignal | undefined,
  ): LlmError {
    void err;
    if (caller?.aborted) return new LlmError('aborted', 'Request cancelled.');
    if (overall.aborted) return new LlmError('timeout', 'Local LLM timed out.');
    // Accepted the connection but sent nothing in time: treat like unreachable (fallback-eligible).
    if (connect?.aborted) return new LlmError('unreachable', 'Local LLM is not responding.', 'stalled');
    return new LlmError('unreachable', 'Local LLM is unreachable.');
  }
}
