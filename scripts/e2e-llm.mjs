// Real end-to-end check against the configured local Ollama (read-only use):
//   1) GET /api/tags  (is it reachable, is LLM_MODEL already installed?)
//   2) one prompt through the app's own provider layer (/api/chat, no keep_alive)
// It never pulls, loads/unloads or changes models. If LLM_MODEL is not in /api/tags it stops.
import 'dotenv/config';
import { loadLlmConfig } from '../server/llm/config.ts';
import { OllamaProvider } from '../server/llm/ollama.ts';
import { visualize } from '../server/llm/visualize.ts';

const config = loadLlmConfig();
const provider = new OllamaProvider(config);
const status = await provider.status(true);
console.log(`model=${config.model} reachable=${status.reachable} installed=${status.modelInstalled} via=${status.via}`);
if (!status.reachable) {
  console.log('SKIP: local Ollama is not reachable from this machine.');
  process.exit(2);
}
if (!status.modelInstalled) {
  console.log('STOP: model is not installed on the LLM host; not pulling anything.');
  process.exit(3);
}
const prompt = process.argv[2] || 'galaxy spiral in neon pink';
const t0 = Date.now();
let deltas = 0;
const r = await visualize(prompt, { config, provider }, { onReplyDelta: () => deltas++ });
console.log(JSON.stringify({ prompt, ms: Date.now() - t0, deltas, ...r }, null, 2));
process.exit(r.source === 'llm' ? 0 : 1);
