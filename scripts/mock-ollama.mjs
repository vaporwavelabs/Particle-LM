// Tiny fake Ollama for tests/smoke (GET /api/tags, POST /api/chat streaming).
import http from 'node:http';

export function startMockOllama(port = 0, { delayMs = 40 } = {}) {
  const log = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      log.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
      if (req.method === 'GET' && req.url === '/api/tags') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ models: [{ name: 'gemma3:12b', model: 'gemma3:12b' }] }));
      }
      if (req.method === 'POST' && req.url === '/api/chat') {
        const prompt = JSON.parse(body).messages.at(-1).content.toLowerCase();
        const heart = prompt.includes('heart');
        const answer = JSON.stringify({
          reply: heart ? 'A glowing heart that beats softly.' : 'A neon pink spiral galaxy, slowly turning.',
          label: heart ? 'Glowing heart' : 'Neon galaxy',
          shape: heart ? 'heart' : 'galaxy',
          behavior: heart ? 'pulse' : 'orbit',
          primary: heart ? '#ff073a' : '#ff2fd0',
          accent: '#8b5cf6',
          background: '#05020a',
          speed: 1.1,
          size: 1.5,
          turbulence: 0.3,
          shapeStrength: 0.85,
          force: 1.6,
        });
        res.setHeader('content-type', 'application/x-ndjson');
        for (let i = 0; i < answer.length; i += 12) {
          if (res.destroyed) return;
          res.write(JSON.stringify({ message: { role: 'assistant', content: answer.slice(i, i + 12) }, done: false }) + '\n');
          await new Promise((r) => setTimeout(r, delayMs));
        }
        res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
        return;
      }
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, log })));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = await startMockOllama(Number(process.argv[2] || 11999));
  console.log(`mock ollama on http://127.0.0.1:${port}`);
}
