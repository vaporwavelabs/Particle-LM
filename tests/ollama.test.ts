import { describe, expect, it } from 'vitest';
import { loadLlmConfig } from '../server/llm/config.ts';
import { LlmError, OllamaProvider } from '../server/llm/ollama.ts';
import { GOOD_ANSWER, mockFetch, ndjsonResponse, ollamaStream } from './helpers.ts';

const env = { LLM_BASE_URL: 'http://primary.test:11434', LLM_FALLBACK_URL: 'http://fallback.test:11440', LLM_TIMEOUT_MS: '2000' };
const cfg = loadLlmConfig(env);

/** Accepts the request but never sends headers (until aborted). */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
  });
}

/** Sends headers + one chunk, then stalls the body (errors when aborted, like undici). */
function headersThenHang(init?: RequestInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content: '{"reply":"' } })}\n`));
      init?.signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
    },
  });
  return new Response(stream, { status: 200 });
}

describe('config', () => {
  it('defaults to the 3090 Ollama and gemma4:e4b', () => {
    const c = loadLlmConfig({});
    expect(c.baseUrl).toBe('http://192.168.87.10:11434');
    expect(c.model).toBe('gemma4:e4b');
    expect(c.fallbackUrl).toBeUndefined();
    expect(c.offline).toBe(false);
  });
  it('invalid LLM_BASE_URL is a config error (LLM disabled), never a silent default; bad fallback/model warn', () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'file:///etc/passwd', LLM_FALLBACK_URL: 'http://u:p@x.test', LLM_MODEL: 'a b; rm' });
    expect(c.configErrors).toEqual([expect.stringMatching(/LLM_BASE_URL/)]);
    expect(c.configErrors.join()).not.toMatch(/etc\/passwd/);
    expect(c.fallbackUrl).toBeUndefined();
    expect(c.model).toBe('gemma4:e4b');
    expect(c.configWarnings).toEqual([expect.stringMatching(/LLM_FALLBACK_URL/), expect.stringMatching(/LLM_MODEL/)]);
    expect(loadLlmConfig({ LLM_BASE_URL: 'not a url' }).configErrors).toHaveLength(1);
    expect(loadLlmConfig({}).configErrors).toEqual([]);
    expect(loadLlmConfig({}).connectTimeoutMs).toBe(6000);
    expect(loadLlmConfig({ LLM_CONNECT_TIMEOUT_MS: '2500' }).connectTimeoutMs).toBe(2500);
  });
  it('think/num_predict/tags timeout defaults and overrides', () => {
    const d = loadLlmConfig({});
    expect(d.think).toBe(false);
    expect(d.numPredict).toBe(600);
    expect(d.tagsTimeoutMs).toBe(6000);
    const o = loadLlmConfig({ LLM_THINK: 'true', LLM_NUM_PREDICT: '900', LLM_TAGS_TIMEOUT_MS: '8000' });
    expect([o.think, o.numPredict, o.tagsTimeoutMs]).toEqual([true, 900, 8000]);
    expect(loadLlmConfig({ LLM_THINK: 'omit' }).think).toBeUndefined();
    expect(loadLlmConfig({ LLM_NUM_PREDICT: 'abc' }).numPredict).toBe(600);
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
    expect(body.model).toBe('gemma4:e4b');
    expect(body.stream).toBe(true);
    expect(body.format).toEqual({ type: 'object' });
    expect(body).not.toHaveProperty('keep_alive');
    expect(JSON.stringify(body)).not.toMatch(/keep_alive/);
    expect(body.think).toBe(false);
    expect((body.options as Record<string, unknown>).num_predict).toBe(600);
  });

  it('ignores message.thinking chunks (never counted as content)', async () => {
    const thinking = 'Let me think about galaxies {"shape":"heart"} ... '.repeat(30);
    const f = mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER, 4, { thinking })));
    const deltas: string[] = [];
    const res = await new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }], { onDelta: (c) => deltas.push(c) });
    expect(res.text).toBe(GOOD_ANSWER);
    expect(deltas.join('')).toBe(GOOD_ANSWER);
  });

  it('retries once without think when an older Ollama rejects it', async () => {
    const f = mockFetch((_u, init) => {
      const body = JSON.parse(String(init?.body));
      if ('think' in body) return new Response('{"error":"\\"gemma3:12b\\" does not support thinking"}', { status: 400 });
      return ndjsonResponse(ollamaStream(GOOD_ANSWER));
    });
    const res = await new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }]);
    expect(res.text).toBe(GOOD_ANSWER);
    expect(res.via).toBe('primary');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].body!.think).toBe(false);
    expect(f.calls[1].body).not.toHaveProperty('think');
  });

  it('does not retry other 400s', async () => {
    const f = mockFetch(() => new Response('{"error":"invalid format"}', { status: 400 }));
    await expect(new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'bad_status' });
    expect(f.calls).toHaveLength(1);
  });

  it('omits think entirely when LLM_THINK=omit', async () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:11434', LLM_THINK: 'omit' });
    const f = mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER)));
    await new OllamaProvider(c, f).chat([{ role: 'user', content: 'x' }]);
    expect(f.calls[0].body).not.toHaveProperty('think');
  });

  it('done_reason=length -> bad_output / truncated', async () => {
    const f = mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER.slice(0, 60), 3, { doneReason: 'length' })));
    await expect(new OllamaProvider(cfg, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({
      code: 'bad_output',
      reason: 'truncated',
    });
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
    const f = mockFetch(() => Response.json({ models: [{ name: 'gemma4:e4b', model: 'gemma4:e4b' }] }));
    const s = await new OllamaProvider(cfg, f).status(true);
    expect(s).toEqual({ reachable: true, modelInstalled: true, via: 'primary', primary: 'ok', lastChat: null });
    expect(f.calls[0].url).toBe('http://primary.test:11434/api/tags');
    expect(f.calls[0].init?.method ?? 'GET').toBe('GET');
  });
  it('reports unreachable', async () => {
    const f = mockFetch(() => {
      throw new TypeError('down');
    });
    expect(await new OllamaProvider(cfg, f).status(true)).toEqual({
      reachable: false,
      modelInstalled: false,
      via: null,
      primary: 'down',
      lastChat: null,
    });
  });
  it('a hanging primary probe is reported as stalled, fallback answers', async () => {
    const c = loadLlmConfig({ ...env, LLM_TAGS_TIMEOUT_MS: '500' });
    const f = mockFetch((url, init) => (url.startsWith('http://primary.test') ? hang(init) : Response.json({ models: [{ name: c.model }] })));
    const s = await new OllamaProvider(c, f).status(true);
    expect(s).toMatchObject({ reachable: true, via: 'fallback', primary: 'stalled' });
  });
  it('a failed chat overrides an older green probe (no false "online")', async () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:11434', LLM_CONNECT_TIMEOUT_MS: '500' });
    let chatHang = false;
    const f = mockFetch((url, init) => {
      if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: c.model }] });
      chatHang = true;
      return hang(init);
    });
    const p = new OllamaProvider(c, f);
    expect((await p.status(true)).primary).toBe('ok');
    await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'unreachable', reason: 'stalled' });
    expect(chatHang).toBe(true);
    const s = await p.status();
    expect(s).toMatchObject({ lastChat: 'failed', primary: 'stalled' });
  });
});

describe('connect / first-byte timeout (P2-1)', () => {
  it('a hanging primary falls back within LLM_CONNECT_TIMEOUT_MS', async () => {
    const c = loadLlmConfig({ ...env, LLM_CONNECT_TIMEOUT_MS: '400', LLM_TIMEOUT_MS: '10000', LLM_TAGS_TIMEOUT_MS: '500' });
    const f = mockFetch((url, init) =>
      url.startsWith('http://primary.test')
        ? hang(init)
        : url.endsWith('/api/tags')
          ? Response.json({ models: [{ name: c.model }] })
          : ndjsonResponse(ollamaStream(GOOD_ANSWER)),
    );
    const p = new OllamaProvider(c, f);
    const t0 = Date.now();
    const res = await p.chat([{ role: 'user', content: 'x' }]);
    const ms = Date.now() - t0;
    expect(res.via).toBe('fallback');
    expect(res.text).toBe(GOOD_ANSWER);
    expect(ms).toBeGreaterThanOrEqual(350);
    expect(ms).toBeLessThan(2000);
    expect(f.calls.map((x) => x.url)).toEqual(['http://primary.test:11434/api/chat', 'http://fallback.test:11440/api/chat']);
    expect(f.calls[0].init?.signal?.aborted).toBe(true); // the stalled request was aborted cleanly
    // status right after the chat reflects what the chat saw (no probe needed)
    expect(await p.status()).toMatchObject({ via: 'fallback', primary: 'stalled', lastChat: 'ok' });
    await p.status(true);
    expect(await p.status()).toMatchObject({ via: 'fallback', primary: 'stalled', lastChat: 'ok' });
  });

  it('after a stall, the next prompt goes to the fallback first (no repeated connect wait)', async () => {
    const c = loadLlmConfig({ ...env, LLM_CONNECT_TIMEOUT_MS: '400', LLM_TAGS_TIMEOUT_MS: '500' });
    const f = mockFetch((url, init) =>
      url.startsWith('http://primary.test')
        ? hang(init)
        : url.endsWith('/api/tags')
          ? Response.json({ models: [{ name: c.model }] })
          : ndjsonResponse(ollamaStream(GOOD_ANSWER)),
    );
    const p = new OllamaProvider(c, f);
    await p.chat([{ role: 'user', content: 'x' }]);
    const t0 = Date.now();
    const res = await p.chat([{ role: 'user', content: 'y' }]);
    expect(res.via).toBe('fallback');
    expect(Date.now() - t0).toBeLessThan(300);
    expect(f.calls.map((x) => x.url.split('/')[2])).toEqual(['primary.test:11434', 'fallback.test:11440', 'fallback.test:11440']);
    expect(f.calls.every((x) => x.url.endsWith('/api/chat'))).toBe(true);
    expect(await p.status()).toMatchObject({ primary: 'stalled', via: 'fallback' });
  });

  it('a hang after the first byte does not fall back (overall timeout applies)', async () => {
    const c = loadLlmConfig({ ...env, LLM_CONNECT_TIMEOUT_MS: '300', LLM_TIMEOUT_MS: '1200' });
    const f = mockFetch((url, init) => (url.startsWith('http://primary.test') ? headersThenHang(init) : ndjsonResponse(ollamaStream(GOOD_ANSWER))));
    const t0 = Date.now();
    await expect(new OllamaProvider(c, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'timeout' });
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(1100);
    expect(ms).toBeLessThan(3000);
    expect(f.calls).toHaveLength(1);
  });

  it('a hanging primary with no fallback goes offline after the connect timeout, not the overall timeout', async () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:11434', LLM_CONNECT_TIMEOUT_MS: '400', LLM_TIMEOUT_MS: '45000' });
    const f = mockFetch((_u, init) => hang(init));
    const t0 = Date.now();
    await expect(new OllamaProvider(c, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'unreachable', reason: 'stalled' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(f.calls).toHaveLength(1);
  });

  it('the overall budget is shared across endpoints', async () => {
    const c = loadLlmConfig({ ...env, LLM_CONNECT_TIMEOUT_MS: '5000', LLM_TIMEOUT_MS: '1000' });
    const f = mockFetch((_u, init) => hang(init));
    const t0 = Date.now();
    await expect(new OllamaProvider(c, f).chat([{ role: 'user', content: 'x' }])).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it('caller cancel during a stall aborts without fallback', async () => {
    const ctrl = new AbortController();
    const c = loadLlmConfig({ ...env, LLM_CONNECT_TIMEOUT_MS: '5000' });
    const f = mockFetch((_u, init) => hang(init));
    const pr = new OllamaProvider(c, f).chat([{ role: 'user', content: 'x' }], { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await expect(pr).rejects.toMatchObject({ code: 'aborted' });
    expect(f.calls).toHaveLength(1);
  });
});
