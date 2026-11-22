import express, { type NextFunction, type Request, type Response } from 'express';
import { MAX_PROMPT_CHARS } from '../shared/params.ts';
import type { LlmConfig } from './llm/config.ts';
import { LlmError, OllamaProvider } from './llm/ollama.ts';
import { PromptError, visualize } from './llm/visualize.ts';

export interface AppOptions {
  config: LlmConfig;
  provider?: OllamaProvider;
  production?: boolean;
  maxInFlight?: number;
  ratePerMinute?: number;
}

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

export function createApp(opts: AppOptions) {
  const provider = opts.provider ?? new OllamaProvider(opts.config);
  const maxInFlight = opts.maxInFlight ?? 2;
  const ratePerMinute = opts.ratePerMinute ?? 40;
  let inFlight = 0;
  const hits = new Map<string, number[]>();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (opts.production) res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  app.use('/api', express.json({ limit: `${MAX_PROMPT_CHARS * 4 + 1024}b` }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'particle-lm' });
  });

  // Deliberately exposes no URLs: only mode + model name.
  app.get('/api/llm/status', async (req, res) => {
    if (opts.config.offline) {
      return res.json({ mode: 'disabled', model: opts.config.model });
    }
    const s = await provider.status(req.query.refresh === '1');
    res.json({
      mode: s.reachable ? (s.modelInstalled ? 'online' : 'model-missing') : 'offline',
      model: opts.config.model,
      via: s.via,
    });
  });

  app.post('/api/visualize', async (req: Request, res: Response) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= ratePerMinute) {
      return res.status(429).json({ error: 'Too many requests, slow down a little.' });
    }
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 1000) hits.clear();

    const prompt = (req.body as { prompt?: unknown } | undefined)?.prompt;
    const stream = req.query.stream === '1';
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    if (inFlight >= maxInFlight) {
      return res.status(429).json({ error: 'The local LLM is busy, try again in a moment.' });
    }
    inFlight++;
    try {
      if (!stream) {
        const result = await visualize(prompt, { config: opts.config, provider }, { signal: controller.signal });
        return res.json(result);
      }
      // Validate before switching to a streamed response so errors keep proper status codes.
      if (typeof prompt !== 'string' || !prompt.trim()) throw new PromptError(400, 'Type something to visualize.');
      if (prompt.trim().length > MAX_PROMPT_CHARS) {
        throw new PromptError(413, `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).`);
      }
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      const write = (obj: unknown) => {
        if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(obj)}\n`);
      };
      write({ type: 'start' });
      let lastSent = 0;
      const result = await visualize(
        prompt,
        { config: opts.config, provider },
        {
          signal: controller.signal,
          onReplyDelta: (partial, chars) => {
            const t = Date.now();
            if (t - lastSent < 50) return; // coalesce
            lastSent = t;
            write({ type: 'delta', reply: partial, chars });
          },
        },
      );
      write({ type: 'result', ...result });
      res.end();
    } catch (err) {
      if (err instanceof LlmError && err.code === 'aborted') {
        if (!res.writableEnded) res.end();
        return;
      }
      const status = err instanceof PromptError ? err.status : 500;
      const message = err instanceof PromptError ? err.message : 'Something went wrong.';
      if (res.headersSent) {
        res.write(`${JSON.stringify({ type: 'error', message })}\n`);
        res.end();
      } else {
        res.status(status).json({ error: message });
      }
    } finally {
      inFlight--;
    }
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  // Generic error handler: never leaks stack traces or upstream URLs.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    void next;
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
    if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    res.status(e?.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: 'Something went wrong.' });
  });

  return { app, provider };
}
