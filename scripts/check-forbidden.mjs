// Static guard: no Google/Gemini/cloud AI references and no raw-HTML sinks in shipped code.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['src', 'server', 'shared', 'server.ts', 'index.html', 'package.json', 'package-lock.json', '.env.example', 'vite.config.ts', 'dist'];
const forbidden = [
  /generativelanguage\.googleapis/i,
  /@google\/(genai|generative-ai)/i,
  /\bgemini\b/i,
  /GEMINI_API_KEY|GOOGLE_API_KEY/,
  /AIza[0-9A-Za-z_-]{35}/,
  /\bvertex\b/i,
  /aistudio/i,
  /fonts\.(googleapis|gstatic)\.com/i,
  /api\.openai\.com|api\.anthropic\.com|api\.groq\.com|api\.mistral\.ai|openrouter\.ai/i,
];
const sinks = [/dangerouslySetInnerHTML/, /\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /document\.write\(/, /\beval\(/, /new Function\(/];

function* walk(p) {
  if (!existsSync(p)) return;
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p)) yield* walk(join(p, f));
  } else yield p;
}

const hits = [];
for (const r of roots) {
  for (const file of walk(r)) {
    if (/\.(png|jpe?g|gif|webp|ico|woff2?)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const re of forbidden) if (re.test(text)) hits.push(`${file}: forbidden ${re}`);
    // React's own bundle contains innerHTML handling; only scan our sources for sinks.
    if (!file.startsWith('dist')) for (const re of sinks) if (re.test(text)) hits.push(`${file}: html/code sink ${re}`);
  }
}
if (hits.length) {
  console.error(hits.join('\n'));
  process.exit(1);
}
console.log('check-forbidden: OK (no Google/cloud-AI references, no HTML/code sinks)');
