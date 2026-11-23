import type { AddressInfo } from 'node:net';
import http, { type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CSP, createApp } from '../server/app.ts';
import { loadLlmConfig } from '../server/llm/config.ts';
import { OllamaProvider } from '../server/llm/ollama.ts';
import { GOOD_ANSWER, mockFetch, ndjsonResponse, ollamaStream } from './helpers.ts';

let server: Server | undefined;
afterEach(() => server?.close());

async function start(
  handler: Parameters<typeof mockFetch>[0],
  extra: { production?: boolean; offline?: boolean; env?: Record<string, string>; allowedHosts?: string[] } = {},
) {
  const config = loadLlmConfig({ LLM_BASE_URL: 'http://10.9.8.7:11434', LLM_OFFLINE: extra.offline ? '1' : '0', ...extra.env });
  const f = mockFetch(handler);
  const { app } = createApp({
    config,
    provider: new OllamaProvider(config, f),
    production: extra.production,
    allowedHosts: extra.allowedHosts,
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, f };
}

describe('HTTP API', () => {
  it('status exposes mode + model but no URLs', async () => {
    const { base } = await start(() => Response.json({ models: [{ name: 'gemma4:e4b' }] }));
    const res = await fetch(`${base}/api/llm/status`);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ mode: 'online', model: 'gemma4:e4b' });
    expect(text).not.toMatch(/10\.9\.8\.7|11434|http/);
  });

  it('streams NDJSON deltas then a result', async () => {
    const { base } = await start(() => ndjsonResponse(ollamaStream(GOOD_ANSWER, 12), { delayMs: 60 }));
    const res = await fetch(`${base}/api/visualize?stream=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'galaxy spiral in neon pink' }),
    });
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(events[0].type).toBe('start');
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    const result = events.at(-1);
    expect(result.type).toBe('result');
    expect(result.source).toBe('llm');
    expect(result.params.shape).toBe('galaxy');
  });

  it('non-stream JSON works and unreachable LLM yields offline result without leaking URL', async () => {
    const { base } = await start(() => {
      throw new TypeError('connect ECONNREFUSED 10.9.8.7:11434');
    });
    const res = await fetch(`${base}/api/visualize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'heart' }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ source: 'offline', params: { shape: 'heart' } });
    expect(text).not.toMatch(/10\.9\.8\.7|11434|ECONN|at .*\.ts/);
  });

  it('validates input with proper status codes', async () => {
    const { base } = await start(() => ndjsonResponse(ollamaStream(GOOD_ANSWER)));
    const post = (body: string, q = '') =>
      fetch(`${base}/api/visualize${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect((await post(JSON.stringify({ prompt: '' }), '?stream=1')).status).toBe(400);
    expect((await post(JSON.stringify({ prompt: 'x'.repeat(4001) }), '?stream=1')).status).toBe(413);
    const bad = await post('{not json');
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toMatch(/SyntaxError|at /);
    expect((await post(JSON.stringify({ prompt: 'z'.repeat(60_000) }))).status).toBe(413);
  });

  it('sets security headers and a self-only CSP in production; no CORS', async () => {
    const { base } = await start(() => Response.json({ models: [] }), { production: true });
    const res = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(CSP).toMatch(/connect-src 'self'/);
    expect(CSP).not.toMatch(/google|http:/);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('client disconnect aborts the upstream LLM request', async () => {
    let upstreamAborted = false;
    const { base } = await start(
      (_u, init) =>
        new Promise<Response>((_r, rej) => {
          init?.signal?.addEventListener('abort', () => {
            upstreamAborted = true;
            rej(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const ctrl = new AbortController();
    const p = fetch(`${base}/api/visualize?stream=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'heart' }),
      signal: ctrl.signal,
    }).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await p.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamAborted).toBe(true);
  });

  it('offline mode never touches the network', async () => {
    const { base, f } = await start(() => ndjsonResponse(ollamaStream(GOOD_ANSWER)), { offline: true });
    const r = await (await fetch(`${base}/api/visualize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"storm"}' })).json();
    expect(r.source).toBe('offline');
    expect((await (await fetch(`${base}/api/llm/status`)).json()).mode).toBe('disabled');
    expect(f.calls).toHaveLength(0);
  });

  it('status is amber "fallback" with primary stalled when the primary hangs', async () => {
    const hang = (init?: RequestInit) =>
      new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort'))));
    const { base } = await start(
      (url, init) => (url.startsWith('http://10.9.8.7') ? hang(init) : url.endsWith('/api/tags') ? Response.json({ models: [{ name: 'gemma4:e4b' }] }) : ndjsonResponse(ollamaStream(GOOD_ANSWER))),
      { env: { LLM_FALLBACK_URL: 'http://10.9.8.8:11440', LLM_CONNECT_TIMEOUT_MS: '300', LLM_TAGS_TIMEOUT_MS: '500' } },
    );
    const st = await (await fetch(`${base}/api/llm/status?refresh=1`)).json();
    expect(st).toMatchObject({ mode: 'fallback', via: 'fallback', primary: 'stalled' });
    const t0 = Date.now();
    const r = await (await fetch(`${base}/api/visualize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"heart"}' })).json();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.source).toBe('llm');
  });

  it('status is "failing" (not green) after a chat failed on all endpoints', async () => {
    const { base } = await start(
      (url, init) =>
        url.endsWith('/api/tags')
          ? Response.json({ models: [{ name: 'gemma4:e4b' }] })
          : new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort')))),
      { env: { LLM_CONNECT_TIMEOUT_MS: '300' } },
    );
    expect((await (await fetch(`${base}/api/llm/status?refresh=1`)).json()).mode).toBe('online');
    const r = await (await fetch(`${base}/api/visualize`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"heart"}' })).json();
    expect(r.notice).toMatch(/not responding/);
    expect((await (await fetch(`${base}/api/llm/status`)).json())).toMatchObject({ mode: 'failing', primary: 'stalled' });
  });

  it('invalid LLM_BASE_URL -> status "misconfigured" with a notice, no network', async () => {
    const { base, f } = await start(() => Response.json({ models: [] }), { env: { LLM_BASE_URL: 'nope://x' } });
    const st = await (await fetch(`${base}/api/llm/status`)).json();
    expect(st.mode).toBe('misconfigured');
    expect(st.notice).toMatch(/LLM_BASE_URL/);
    expect(JSON.stringify(st)).not.toMatch(/nope:/);
    expect(f.calls).toHaveLength(0);
  });

  it('two sends at once from one client: newest wins, never a 429', async () => {
    const { base } = await start(() => ndjsonResponse(ollamaStream(GOOD_ANSWER, 10), { delayMs: 80 }));
    const send = () =>
      fetch(`${base}/api/visualize?stream=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'galaxy' }),
      }).then(async (r) => ({ status: r.status, text: await r.text() }));
    const results = await Promise.all([send(), send(), send()]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    const finals = results.map((r) => r.text.trim().split('\n').map((l) => JSON.parse(l)).at(-1));
    expect(finals.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(finals.filter((e) => e.type === 'error').every((e) => e.message === 'Replaced by a newer prompt.')).toBe(true);
  });

  it('Host allowlist: foreign Host gets 421, loopback / ALLOWED_HOSTS pass', async () => {
    const { base } = await start(() => Response.json({ models: [] }), { allowedHosts: ['particles.lan'] });
    const port = new URL(base).port;
    const get = (host: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });
    expect(await get('evil.example')).toBe(421);
    expect(await get('evil.example:3000')).toBe(421);
    expect(await get(`127.0.0.1:${port}`)).toBe(200);
    expect(await get(`localhost:${port}`)).toBe(200);
    expect(await get('[::1]:3000')).toBe(200);
    expect(await get('particles.lan:3000')).toBe(200);
  });
});
