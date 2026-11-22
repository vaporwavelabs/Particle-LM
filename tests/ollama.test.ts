import { describe, expect, it } from 'vitest';
import { loadLlmConfig } from '../server/llm/config.ts';
import { LlmError, OllamaProvider } from '../server/llm/ollama.ts';
import { GOOD_ANSWER, mockFetch, ndjsonResponse, ollamaStream } from './helpers.ts';

const cfg = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:11434', LLM_FALLBACK_URL: 'http://fallback.test:11440', LLM_TIMEOUT_MS: '2000' });

describe('config', () => {
  it('defaults to the 3090 Ollama and gemma3:12b', () => {
    const c = loadLlmConfig({});
    expect(c.baseUrl).toBe('http://192.168.87.10:11434');
    expect(c.model).toBe('gemma3:12b');
    expect(c.fallbackUrl).toBeUndefined();
    expect(c.offline).toBe(false);
  });
  it('rejects non-http URLs, credentials and odd model names', () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'file:///etc/passwd', LLM_FALLBACK_URL: 'http://u:p@x.test', LLM_MODEL: 'a b; rm' });
    expect(c.baseUrl).toBe('http://192.168.87.10:11434');
    expect(c.fallbackUrl).toBeUndefined();
    expect(c.model).toBe('gemma3:12b');
  });
  it('LLM_OFFLINE=1 disables the LLM', () => {
    expect(loadLlmConfig({ LLM_OFFLINE: '1' }).offline).toBe(true);
  });
});

describe('OllamaProvider.chat', () => {
  it('streams /api/chat with structured format and never sends keep_alive', async () => {
    const f = mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER)));
    const p = new OllamaProvider(cfg, f);
    const deltas: string[] = [];
    const res = await p.chat([{ role: 'user', content: 'hi' }], { format: { type: 'object' }, onDelta: (c) => deltas.push(c) });
    expect(res.text).toBe(GOOD_ANSWER);
    expect(res.via).toBe('primary');
    expect(deltas.join('')).toBe(GOOD_ANSWER);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('http://primary.test:11434/api/chat');
    const body = f.calls[0].body!;
    expect(body.model).toBe('gemma3:12b');
    expect(body.stream).toBe(true);
    expect(body.format).toEqual({ type: 'object' });
    expect(body).not.toHaveProperty('keep_alive');
    expect(JSON.stringify(body)).not.toMatch(/keep_alive/);
  });

  it('falls back to LLM_FALLBACK_URL only on connection failure', async () => {
    const f = mockFetch((url) => {
      if (url.startsWith('http://primary.test')) throw new TypeError('fetch failed');
      return ndjsonResponse(ollamaStream(GOOD_ANSWER));
    });
    const res = await new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }]);
    expect(res.via).toBe('fallback');
    expect(f.calls.map((c) => c.url)).toEqual(['http://primary.test:11434/api/chat', 'http://fallback.test:11440/api/chat']);
  });

  it('does not fall back on HTTP errors', async () => {
    const f = mockFetch(() => new Response('boom', { status: 500 }));
    await expect(new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'bad_status' });
    expect(f.calls).toHaveLength(1);
  });

  it('reports a missing model without pulling it', async () => {
    const f = mockFetch(() => new Response('{"error":"model \\"gemma3:12b\\" not found, try pulling it first"}', { status: 404 }));
    await expect(new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'model_missing' });
    expect(f.calls.every((c) => !c.url.includes('/api/pull'))).toBe(true);
  });

  it('errors never contain the upstream URL', async () => {
    const f = mockFetch(() => {
      throw new TypeError('connect ECONNREFUSED http://primary.test:11434');
    });
    const err = await new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }]).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.code).toBe('unreachable');
    expect(String(err.message)).not.toMatch(/primary\.test|fallback\.test|11434|ECONN/);
  });

  it('times out', async () => {
    const fast = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:1', LLM_TIMEOUT_MS: '1000' });
    const f = mockFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    await expect(new OllamaProvider(fast, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'timeout' });
  });

  it('honours caller cancellation', async () => {
    const ctrl = new AbortController();
    const f = mockFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const pr = new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 20);
    await expect(pr).rejects.toMatchObject({ code: 'aborted' });
    expect(f.calls).toHaveLength(1); // no fallback after a cancel
  });

  it('surfaces in-stream errors', async () => {
    const f = mockFetch(() => ndjsonResponse(['{"error":"out of memory"}\n']));
    await expect(new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'bad_output' });
  });
});

describe('OllamaProvider.status', () => {
  it('uses GET /api/tags only and detects the model', async () => {
    const f = mockFetch(() => Response.json({ models: [{ name: 'gemma3:12b', model: 'gemma3:12b' }] }));
    const s = await new OllamaProvider(cfg, f).status(true);
    expect(s).toEqual({ reachable: true, modelInstalled: true, via: 'primary' });
    expect(f.calls[0].url).toBe('http://primary.test:11434/api/tags');
    expect(f.calls[0].init?.method ?? 'GET').toBe('GET');
  });
  it('reports unreachable', async () => {
    const f = mockFetch(() => {
      throw new TypeError('down');
    });
    expect(await new OllamaProvider(cfg, f).status(true)).toEqual({ reachable: false, modelInstalled: false, via: null });
  });
});
