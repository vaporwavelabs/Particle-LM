/**
 * Minimal Ollama provider (local only). Talks to /api/tags and /api/chat.
 * Never sends keep_alive, never pulls/loads/unloads models explicitly,
 * never includes the upstream URL in errors that reach the browser.
 */
import type { LlmConfig } from './config.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type LlmErrorCode = 'unreachable' | 'timeout' | 'bad_status' | 'model_missing' | 'aborted' | 'bad_output';

export type LlmErrorReason = 'truncated' | 'think_unsupported';

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

export interface LlmStatus {
  reachable: boolean;
  modelInstalled: boolean;
  via: 'primary' | 'fallback' | null;
}

export class OllamaProvider {
  private readonly cfg: LlmConfig;
  private readonly fetchImpl: FetchLike;
  private statusCache: { at: number; value: LlmStatus } | null = null;

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

  /** Read-only health probe via GET /api/tags (cached briefly). */
  async status(force = false): Promise<LlmStatus> {
    if (!force && this.statusCache && Date.now() - this.statusCache.at < 15_000) return this.statusCache.value;
    let value: LlmStatus = { reachable: false, modelInstalled: false, via: null };
    for (const ep of this.endpoints()) {
      try {
        const res = await this.fetchImpl(`${ep.url}/api/tags`, { signal: AbortSignal.timeout(this.cfg.tagsTimeoutMs) });
        if (!res.ok) continue;
        const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
        const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean) as string[];
        value = { reachable: true, modelInstalled: names.includes(this.cfg.model), via: ep.via };
        break;
      } catch {
        // try next endpoint
      }
    }
    this.statusCache = { at: Date.now(), value };
    return value;
  }

  /** Streams a chat completion from POST /api/chat. Falls back to the second URL only on connection failure. */
  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const started = Date.now();
    let lastErr: LlmError = new LlmError('unreachable', 'Local LLM is unreachable.');
    for (const ep of this.endpoints()) {
      if (opts.signal?.aborted) throw new LlmError('aborted', 'Request cancelled.');
      try {
        let text: string;
        try {
          text = await this.chatOnce(ep.url, messages, opts, this.cfg.think);
        } catch (err) {
          // Older Ollama builds reject `think` on non-thinking models: retry once without the field.
          if (err instanceof LlmError && err.reason === 'think_unsupported' && this.cfg.think !== undefined) {
            text = await this.chatOnce(ep.url, messages, opts, undefined);
          } else throw err;
        }
        this.statusCache = { at: Date.now(), value: { reachable: true, modelInstalled: true, via: ep.via } };
        return { text, via: ep.via, ms: Date.now() - started };
      } catch (err) {
        const e = err instanceof LlmError ? err : new LlmError('unreachable', 'Local LLM is unreachable.');
        if (e.code !== 'unreachable') throw e; // only retry on connection failures
        lastErr = e;
      }
    }
    this.statusCache = { at: Date.now(), value: { reachable: false, modelInstalled: false, via: null } };
    throw lastErr;
  }

  private async chatOnce(
    baseUrl: string,
    messages: ChatMessage[],
    opts: ChatOptions,
    think: boolean | undefined,
  ): Promise<string> {
    const timeout = AbortSignal.timeout(this.cfg.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
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
      throw this.classify(err, opts.signal, timeout);
    }

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
    try {
      for (;;) {
        const { value, done } = await reader.read();
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
      if (err instanceof LlmError) throw err;
      const e = this.classify(err, opts.signal, timeout);
      // A failure after streaming started is not a connection failure: don't fall back.
      throw e.code === 'unreachable' ? new LlmError('bad_output', 'Local LLM stream was interrupted.') : e;
    } finally {
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

  private classify(err: unknown, caller: AbortSignal | undefined, timeout: AbortSignal): LlmError {
    if (caller?.aborted) return new LlmError('aborted', 'Request cancelled.');
    if (timeout.aborted) return new LlmError('timeout', 'Local LLM timed out.');
    void err;
    return new LlmError('unreachable', 'Local LLM is unreachable.');
  }
}
