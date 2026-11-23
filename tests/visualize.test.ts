import { describe, expect, it } from 'vitest';
import { loadLlmConfig } from '../server/llm/config.ts';
import { OllamaProvider } from '../server/llm/ollama.ts';
import { extractJson, partialReply, visualize } from '../server/llm/visualize.ts';
import { GOOD_ANSWER, mockFetch, ndjsonResponse, ollamaStream } from './helpers.ts';

const config = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:11434' });
const deps = (answer: string | (() => Response)) => {
  const f = mockFetch(() => (typeof answer === 'string' ? ndjsonResponse(ollamaStream(answer)) : answer()));
  return { config, provider: new OllamaProvider(config, f), f };
};

describe('visualize', () => {
  it('uses the LLM result when valid', async () => {
    const d = deps(GOOD_ANSWER);
    const partials: string[] = [];
    const r = await visualize('galaxy spiral in neon pink', d, { onReplyDelta: (p) => partials.push(p) });
    expect(r.source).toBe('llm');
    expect(r.params.shape).toBe('galaxy');
    expect(r.params.primary).toBe('#ff2fd0');
    expect(r.reply).toMatch(/spiral galaxy/);
    expect(partials.at(-1)).toMatch(/spiral galaxy/);
    const sys = (d.f.calls[0].body!.messages as Array<{ role: string; content: string }>)[0];
    expect(sys.role).toBe('system');
  });

  it('clamps wild LLM numbers', async () => {
    const r = await visualize('x', deps(JSON.stringify({ shape: 'heart', speed: 500, size: -1, force: 1e9, reply: 'ok' })));
    expect(r.source).toBe('llm');
    expect(r.params.speed).toBe(3);
    expect(r.params.size).toBe(0.5);
    expect(r.params.force).toBe(4);
    expect(r.issues).toEqual(expect.arrayContaining(['speed clamped']));
  });

  it('fills invalid LLM fields from the offline parse of the same prompt', async () => {
    const r = await visualize('golden tornado', deps(JSON.stringify({ shape: 'banana', reply: 'hm' })));
    expect(r.source).toBe('llm');
    expect(r.params.shape).toBe('tornado');
  });

  it('falls back to the offline parser on invalid JSON', async () => {
    const r = await visualize('beating red heart', deps('this is not json at all'));
    expect(r.source).toBe('offline');
    expect(r.params.shape).toBe('heart');
    expect(r.notice).toMatch(/unusable output/);
  });

  it('truncated output (done_reason=length) -> offline with "cut off" notice', async () => {
    const d = { config, provider: new OllamaProvider(config, mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER.slice(0, 50), 2, { thinking: 'hmm '.repeat(300), doneReason: 'length' })))) };
    const r = await visualize('beating red heart', d);
    expect(r.source).toBe('offline');
    expect(r.params.shape).toBe('heart');
    expect(r.notice).toMatch(/Local LLM output was cut off/);
  });

  it('thinking model with fenced JSON still parses', async () => {
    const fenced = 'Here you go:\n```json\n' + GOOD_ANSWER + '\n```\nEnjoy!';
    const d = { config, provider: new OllamaProvider(config, mockFetch(() => ndjsonResponse(ollamaStream(fenced, 6, { thinking: 'reasoning '.repeat(100) })))) };
    const r = await visualize('galaxy', d);
    expect(r.source).toBe('llm');
    expect(r.params.shape).toBe('galaxy');
  });

  it('falls back to offline when unreachable, with a clear notice and no URL leak', async () => {
    const r = await visualize('storm', deps(() => {
      throw new TypeError('ECONNREFUSED 192.168.87.10:11434');
    }));
    expect(r.source).toBe('offline');
    expect(r.notice).toMatch(/unreachable/);
    expect(JSON.stringify(r)).not.toMatch(/192\.168|11434|primary\.test|ECONN/);
  });

  it('stalled primary with no fallback -> offline with "not responding" notice', async () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'http://primary.test:11434', LLM_CONNECT_TIMEOUT_MS: '300' });
    const f = mockFetch((_u, init) => new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abort')))));
    const t0 = Date.now();
    const r = await visualize('heart', { config: c, provider: new OllamaProvider(c, f) });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.source).toBe('offline');
    expect(r.notice).toMatch(/not responding/);
  });

  it('invalid LLM_BASE_URL -> offline parser with a clear misconfiguration notice, no network', async () => {
    const c = loadLlmConfig({ LLM_BASE_URL: 'htp:/oops' });
    const f = mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER)));
    const r = await visualize('heart', { config: c, provider: new OllamaProvider(c, f) });
    expect(r.source).toBe('offline');
    expect(r.notice).toMatch(/misconfigured \(invalid LLM_BASE_URL\)/);
    expect(f.calls).toHaveLength(0);
  });

  it('never calls the LLM when LLM_OFFLINE=1', async () => {
    const off = loadLlmConfig({ LLM_OFFLINE: '1' });
    const f = mockFetch(() => ndjsonResponse(ollamaStream(GOOD_ANSWER)));
    const r = await visualize('heart', { config: off, provider: new OllamaProvider(off, f) });
    expect(r.source).toBe('offline');
    expect(f.calls).toHaveLength(0);
  });

  it('rejects empty prompts and over-long prompts; truncates long prompts for the LLM', async () => {
    await expect(visualize('   ', deps(GOOD_ANSWER))).rejects.toMatchObject({ status: 400 });
    await expect(visualize(42, deps(GOOD_ANSWER))).rejects.toMatchObject({ status: 400 });
    await expect(visualize('x'.repeat(4001), deps(GOOD_ANSWER))).rejects.toMatchObject({ status: 413 });
    const d = deps(GOOD_ANSWER);
    const r = await visualize('y'.repeat(4000), d);
    const user = (d.f.calls[0].body!.messages as Array<{ content: string }>)[1].content;
    expect(user.length).toBeLessThanOrEqual(1200);
    expect(r.notice).toMatch(/shortened/);
    // word-y prompts (whitespace at the cut point) are still flagged as shortened
    const r2 = await visualize('heart '.repeat(700).slice(0, 4000), deps(GOOD_ANSWER));
    expect(r2.notice).toMatch(/shortened/);
  });

  it('propagates cancellation instead of falling back', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(visualize('heart', deps(GOOD_ANSWER), { signal: ctrl.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('helpers', () => {
  it('extractJson tolerates fences and chatter', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":2} hope that helps')).toEqual({ a: 2 });
    expect(extractJson('```JSON\n{"a":3}```')).toEqual({ a: 3 });
    expect(extractJson('```\n{"a":{"b":"x"}}\n```')).toEqual({ a: { b: 'x' } });
    expect(extractJson('thinking... ok:\n```json {"a":4} ```')).toEqual({ a: 4 });
    expect(() => extractJson('nope')).toThrow();
  });
  it('partialReply reads an incomplete stream', () => {
    expect(partialReply('{"reply":"A neon pi')).toBe('A neon pi');
    expect(partialReply('{"reply":"say \\"hi\\" now","label"')).toBe('say "hi" now');
    expect(partialReply('{"label":"x"')).toBe('');
  });
});
