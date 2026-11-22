import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './server/app.ts';
import { loadLlmConfig } from './server/llm/config.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');

async function main() {
  const config = loadLlmConfig();
  for (const e of config.configErrors) {
    console.error(`\n[particle-lm] CONFIG ERROR: ${e}. The LLM is DISABLED; prompts use the offline parser until .env is fixed and the server restarted.\n`);
  }
  for (const w of config.configWarnings) console.warn(`[particle-lm] config warning: ${w}`);
  const allowedHosts = (process.env.ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const { app } = createApp({ config, production, allowedHosts });
  const httpServer = http.createServer(app);

  if (!production) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: { server: httpServer } },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath, { index: false, maxAge: '1h' }));
    app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
  }

  httpServer.listen(PORT, HOST, () => {
    // Log the model and mode only (no upstream URLs in logs that may be shared).
    console.log(
      `Particle-LM on http://${HOST}:${PORT}  model=${config.model}  llm=${config.configErrors.length ? 'MISCONFIGURED (offline parser)' : config.offline ? 'disabled (offline parser)' : 'local Ollama'}${config.fallbackUrl ? ' (+fallback)' : ''}`,
    );
  });
}

void main();
