# Particle-LM

Interactive WebGL2 particle visualizer. Type a scene ("galaxy spiral in neon pink", "beating red heart",
"storm") and a **local LLM running in Ollama** turns it into particle parameters: shape, motion, colours,
speed, size, turbulence and touch force. Drag on the particles to attract, repel, swirl or orbit them.

There are **no cloud AI APIs** in this project. The original Google AI Studio export
(Google's generative-AI SDK and API key, its cloud TTS/transcription calls, AI Studio metadata, Google Fonts) was removed and
replaced by the local provider layer described below. (Those references still exist in the two initial commits of the git history.)

## Architecture

```
browser (React + WebGL2)  ──POST /api/visualize?stream=1──▶  server.ts (Express)
   ▲  NDJSON: start / delta / result                               │
   │                                                               ▼
   │                                        server/llm/visualize.ts  ── prompt → JSON params
   │                                             │            │
   │                                             ▼            ▼ (any failure)
   │                              server/llm/ollama.ts    server/llm/offline.ts
   │                              GET /api/tags,          keyword parser (no network)
   │                              POST /api/chat (stream,
   │                              format = JSON schema)
   │                                             │
   └──── shared/params.ts: schema, sanitize + clamp (server AND browser) ◀──┘
```

* **The browser never talks to Ollama.** Only `server.ts` does, using `LLM_BASE_URL` (and `LLM_FALLBACK_URL` on connection failure).
* **Structured output:** Ollama's `format` gets a JSON schema (`PARAMS_JSON_SCHEMA`). The model's JSON is parsed,
  then every field is validated: enums for shape/behaviour, hex/named colours, numbers clamped to `LIMITS`, text capped
  and stripped of control characters, unknown keys dropped. Fields the LLM gets wrong fall back to an offline parse of the same prompt.
* **Offline mode:** if Ollama is disabled (`LLM_OFFLINE=1`), unreachable, times out, lacks the model, or returns junk, the
  server uses `server/llm/offline.ts` and the UI shows a clear notice. There is no cloud fallback.
* **Thinking models:** `think:false` is sent by default; `message.thinking` chunks are never treated as answer text;
  a `done_reason: "length"` reply is reported as truncated ("Local LLM output was cut off") and the offline parser is used.
* **Read-only to the LLM host:** only `GET /api/tags` and `POST /api/chat` with `LLM_MODEL`. No pulls, no loads/unloads, no `keep_alive`.
* **Safety:** LLM text is rendered as plain React text only (no `innerHTML`/`dangerouslySetInnerHTML`). In production
  the server sends a self-only CSP (`connect-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, no CORS. Errors never include upstream URLs or stack traces.
* **Renderer:** `src/engine/ParticleEngine.ts`, WebGL2 transform-feedback simulation (GPU) with 12 shapes
  (`src/engine/shapes.ts`) and 8 motion behaviours, pointer forces in screen space, wheel/pinch zoom, orbit camera,
  auto quality (drops particle count when FPS < 50, recovers when > 58), WebGL context-loss recovery, reduced-motion support.

## Run it

Requires Node 22.18+ (runs `server.ts` directly).

```bash
cp .env.example .env        # edit LLM_BASE_URL / LLM_MODEL if needed
npm ci
npm run dev                 # http://127.0.0.1:3000 (Vite middleware, hot reload)

# production
npm run build
npm start                   # serves dist/ + API on HOST:PORT
```

To try it from a phone on the same Wi-Fi, set `HOST=0.0.0.0` and open `http://<this-pc-ip>:3000`.

| env | default | meaning |
|---|---|---|
| `LLM_BASE_URL` | `http://192.168.87.10:11434` | Ollama on the 3090 PC |
| `LLM_FALLBACK_URL` | (none) | second Ollama URL, used only if the first can't be reached (e.g. `http://192.168.87.10:11440`) |
| `LLM_MODEL` | `gemma4:e4b` | must already be installed (`ollama list`). `gemma3:12b` also works (non-thinking; Ollama loads it on first use if it isn't loaded). |
| `LLM_TIMEOUT_MS` | `45000` | per request |
| `LLM_THINK` | `false` | Ollama `think` flag. `false` disables reasoning on thinking models (e.g. `gemma4:e4b`), whose thinking would otherwise use up the token budget and cut the JSON off. `gemma3:12b` ignores it. `true` allows thinking; `omit` doesn't send the field. If an older Ollama rejects `think` with a 400, the request is retried once without it. |
| `LLM_NUM_PREDICT` | `600` | max output tokens (`options.num_predict`) |
| `LLM_TAGS_TIMEOUT_MS` | `6000` | timeout for the `GET /api/tags` status probe |
| `LLM_OFFLINE` | `0` | `1` = never call the LLM |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | web server |

## Checks

```bash
npm run typecheck           # tsc --noEmit
npm run lint                # tsc + scripts/check-forbidden.mjs (no Google/cloud-AI refs, no HTML sinks)
npm test                    # vitest: params validation/clamping, offline parser, Ollama provider (mocked), API
npm run build && npm run smoke   # headless Chrome vs a mock Ollama; screenshots in shots/
npm run e2e:llm -- "galaxy spiral in neon pink"   # one real prompt against LLM_BASE_URL (read-only)
```

`npm run smoke` needs Chrome/Chromium (`CHROME_PATH` to override).
