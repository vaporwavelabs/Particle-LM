import type { FetchLike } from '../server/llm/ollama.ts';

export function ndjsonResponse(chunks: string[], opts: { status?: number; delayMs?: number } = {}): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      for (const c of chunks) {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        ctrl.enqueue(enc.encode(c));
      }
      ctrl.close();
    },
  });
  return new Response(stream, { status: opts.status ?? 200, headers: { 'content-type': 'application/x-ndjson' } });
}

/** Splits a JSON answer into Ollama /api/chat stream lines. */
export function ollamaStream(answer: string, pieces = 5): string[] {
  const size = Math.ceil(answer.length / pieces);
  const lines: string[] = [];
  for (let i = 0; i < answer.length; i += size) {
    lines.push(`${JSON.stringify({ model: 'gemma3:12b', message: { role: 'assistant', content: answer.slice(i, i + size) }, done: false })}\n`);
  }
  lines.push(`${JSON.stringify({ model: 'gemma3:12b', message: { role: 'assistant', content: '' }, done: true })}\n`);
  return lines;
}

export interface Call {
  url: string;
  init?: RequestInit;
  body?: Record<string, unknown>;
}

export function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response> | Response): FetchLike & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return handler(url, init);
  }) as FetchLike & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

export const GOOD_ANSWER = JSON.stringify({
  reply: 'A neon pink spiral galaxy, slowly turning.',
  label: 'Neon galaxy',
  shape: 'galaxy',
  behavior: 'orbit',
  primary: '#ff2fd0',
  accent: '#8b5cf6',
  background: '#05020a',
  speed: 1.1,
  size: 1.5,
  turbulence: 0.3,
  shapeStrength: 0.85,
  force: 1.6,
});
