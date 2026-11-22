import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { CSP, createApp } from '../server/app.ts';
import { loadLlmConfig } from '../server/llm/config.ts';
import { OllamaProvider } from '../server/llm/ollama.ts';
import { GOOD_ANSWER, mockFetch, ndjsonResponse, ollamaStream } from './helpers.ts';

let server: Server | undefined;
afterEach(() => server?.close());

async function start(handler: Parameters<typeof mockFetch>[0], extra: { production?: boolean; offline?: boolean } = {}) {
  const config = loadLlmConfig({ LLM_BASE_URL: 'http://10.9.8.7:11434', LLM_OFFLINE: extra.offline ? '1' : '0' });
  const f = mockFetch(handler);
  const { app } = createApp({ config, provider: new OllamaProvider(config, f), production: extra.production });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server!.once('listening', r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  return { base, f };
}

describe('HTTP API', () => {
  it('status exposes mode + model but no URLs', async () => {
    const { base } = await start(() => Response.json({ models: [{ name: 'gemma3:12b' }] }));
    const res = await fetch(`${base}/api/llm/status`);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ mode: 'online', model: 'gemma3:12b' });
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
});
