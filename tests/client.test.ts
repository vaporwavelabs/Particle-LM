import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUSY_MESSAGE, visualizeStream } from '../src/lib/api.ts';
import { describeStatus } from '../src/lib/status.ts';

const resultLine = JSON.stringify({
  type: 'result',
  params: { shape: 'heart' },
  reply: 'A heart.',
  source: 'llm',
});

function ndjson(lines: string[]) {
  return new Response(lines.map((l) => `${l}\n`).join(''), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('client: 429 handling', () => {
  it('retries a 429 once, quietly, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'The local LLM is busy, try again in a moment.' }, { status: 429 }))
      .mockResolvedValueOnce(ndjson(['{"type":"start"}', resultLine]));
    vi.stubGlobal('fetch', fetchMock);
    const r = await visualizeStream('heart', new AbortController().signal, () => undefined);
    expect(r.params.shape).toBe('heart');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('two 429s in a row -> friendly busy message (no raw error)', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ error: 'x' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(visualizeStream('heart', new AbortController().signal, () => undefined)).rejects.toThrow(BUSY_MESSAGE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancelling during the 429 back-off stops without another request', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ error: 'x' }, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const ctrl = new AbortController();
    const p = visualizeStream('heart', ctrl.signal, () => undefined);
    setTimeout(() => ctrl.abort(), 50);
    await expect(p).rejects.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('client: status pill', () => {
  it('green only when the primary answers', () => {
    expect(describeStatus({ mode: 'online', model: 'gemma4:e4b' }).tone).toBe('green');
    const fb = describeStatus({ mode: 'fallback', model: 'gemma4:e4b', primary: 'stalled' });
    expect(fb).toEqual({ label: 'Primary stalled, using fallback · gemma4:e4b', tone: 'amber' });
    expect(describeStatus({ mode: 'failing', primary: 'stalled' }).tone).toBe('amber');
    expect(describeStatus({ mode: 'misconfigured' }).label).toMatch(/misconfigured/);
    expect(describeStatus({ mode: 'unknown' }).tone).toBe('grey');
  });
});
