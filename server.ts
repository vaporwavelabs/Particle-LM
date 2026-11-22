import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import type { Content } from '@google/genai';
import {
  executeMcpTool,
  mcpToolDeclarations,
} from './server/mcpRegistry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const VALID_VOICES = new Set(['Kore', 'Fenrir', 'Puck', 'Charon', 'Zephyr']);

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in the server environment.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function synthesizePiperStyleSpeech(
  ai: GoogleGenAI,
  text: string,
  voiceName: string
): Promise<{ audioBase64?: string; audioMimeType?: string; ttsError?: string }> {
  const cleanText = text.trim().slice(0, 420);
  if (!cleanText) return {};

  const safeVoice = VALID_VOICES.has(voiceName) ? voiceName : 'Kore';

  try {
    const ttsResponse = await ai.models.generateContent({
      model: 'gemini-3.8-flash-lite-tts',
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: cleanText,
              speechMetadata: {
                style: 'Crisp, articulate, responsive studio vocal synthesis',
              },
            },
          ],
        },
      ],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: safeVoice },
          },
        },
      },
    });

    const inlineData = ttsResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData;
    if (inlineData?.data) {
      return {
        audioBase64: inlineData.data,
        audioMimeType: inlineData.mimeType || 'audio/wav',
      };
    }
    return { ttsError: 'No audio payload returned from TTS model.' };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'TTS synthesis failed';
    return { ttsError: message };
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '15mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, service: 'kinetix-chant' });
  });

  // Standard MCP discovery & JSON-RPC 2.0 endpoint
  app.get('/api/mcp/tools', (_req, res) => {
    res.json({
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'kinetix-chant-mcp', version: '1.0.0' },
      tools: mcpToolDeclarations.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters,
      })),
    });
  });

  app.post('/api/mcp', (req, res) => {
    const body = req.body as {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    const id = body?.id ?? null;

    if (body?.method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'kinetix-chant-mcp', version: '1.0.0' },
        },
      });
    }

    if (body?.method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: mcpToolDeclarations.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          })),
        },
      });
    }

    if (body?.method === 'tools/call') {
      const toolName = body.params?.name ?? '';
      const toolArgs = body.params?.arguments ?? {};
      const execResult = executeMcpTool(toolName, toolArgs);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          isError: execResult.status === 'error',
          content: [
            {
              type: 'text',
              text: execResult.resultSummary,
            },
          ],
          execution: execResult,
        },
      });
    }

    return res.status(400).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Unsupported MCP method: ${String(body?.method)}` },
    });
  });

  // Standalone TTS endpoint for synthesized Piper-style voice playback
  app.post('/api/tts', async (req, res) => {
    try {
      const { text, voiceName = 'Kore' } = req.body as { text?: string; voiceName?: string };
      if (!text || !text.trim()) {
        return res.status(400).json({ error: 'Text is required for TTS.' });
      }
      const ai = getAiClient();
      const tts = await synthesizePiperStyleSpeech(ai, text, voiceName);
      if (!tts.audioBase64) {
        return res.status(502).json({ error: tts.ttsError || 'TTS generation returned empty audio.' });
      }
      return res.json(tts);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'TTS request failed';
      return res.status(500).json({ error: message });
    }
  });

  // Unified Voice Chant + MCP Tool-Calling + GLSL Mutation + Synthesized Voice Response
  app.post('/api/agent/command', async (req, res) => {
    try {
      const {
        text,
        audioBase64,
        audioMimeType = 'audio/webm',
        currentShader,
        currentPhysics,
        voiceName = 'Kore',
      } = req.body as {
        text?: string;
        audioBase64?: string;
        audioMimeType?: string;
        currentShader?: { forceCode?: string; colorCode?: string };
        currentPhysics?: Record<string, unknown>;
        voiceName?: string;
      };

      const ai = getAiClient();
      let transcript = (text || '').trim();

      // Step 1: Transcribe spoken chant/command if audio was captured
      if (audioBase64 && audioBase64.length > 0) {
        const transcribeResp = await ai.models.generateContent({
          model: 'gemini-3.5-transcribe',
          contents: {
            parts: [
              {
                inlineData: {
                  mimeType: audioMimeType,
                  data: audioBase64,
                },
              },
              {
                text: 'Transcribe the spoken words or vocal chant accurately. If it is purely musical humming or rhythmic chanting without words, briefly describe the vocal rhythm or syllables (e.g. "rhythmic low hum", "chanting ooooh").',
              },
            ],
          },
        });
        const transcribed = (transcribeResp.text || '').trim();
        if (transcribed) {
          transcript = transcript ? `${transcript} (${transcribed})` : transcribed;
        }
      }

      if (!transcript) {
        return res.status(400).json({ error: 'Provide either a text command or recorded voice chant.' });
      }

      // Step 2: Gemini tool-calling loop over MCP tools
      const systemInstruction = `You are the real-time shader and physics choreographer for Kinetix Chant, a 65,536-particle WebGL2 GPU fluid simulation.
When the user speaks a chant, rhythm, or directive:
- Use your MCP tools aggressively and creatively to transform the simulation!
- Use 'mutate_glsl_shader' whenever they ask for custom visual styles, fluid behavior, reactions, mimicry, or shader code changes.
  CRITICAL GLSL RULES for mutate_glsl_shader:
  1. forceCode MUST define exact signature:
     vec3 customForce(vec3 pos, vec3 vel, float time, vec4 audio, vec2 cursor, float cursorDown, float seed)
  2. colorCode MUST define exact signature:
     vec3 customColor(float speed, float energy, vec4 audio, vec3 pos, float seed, vec3 primaryCol, vec3 accentCol)
  3. Only valid GLSL ES 3.00! Use float literals with decimal points (e.g. 1.0, 2.0, not 1 or 2 inside float ops). Never divide by zero (add + 0.0001).
  4. audio.x = bass, audio.y = mid, audio.z = treble, audio.w = cadence transient pulse.
- Use 'run_data_processor' when the user asks to compute mathematical curves, attractors, galaxies, waveforms, or run code via MCP.
- Use 'morph_formation_shape' to imitate torus, helix, mandala, lattice, or release back to fluid.
- Use 'set_simulation_physics' to tune curlStrength, viscosity, cursorForce, audioSensitivity, or colors.
After invoking the MCP tools, answer in 1 to 2 crisp, spoken-friendly sentences summarizing what you changed (no markdown formatting or asterisks since your reply is read aloud via synthesized speech).`;

      const contextSummary = `Current physics: ${JSON.stringify(currentPhysics || {})}
Current customForce GLSL:
${currentShader?.forceCode || ''}
Current customColor GLSL:
${currentShader?.colorCode || ''}

User chant/command: "${transcript}"`;

      const contents: Content[] = [
        { role: 'user', parts: [{ text: contextSummary }] },
      ];

      const toolCallRecords: Array<{
        id: string;
        toolName: string;
        args: Record<string, unknown>;
        resultSummary: string;
        durationMs: number;
        status: 'ok' | 'error';
        timestamp: string;
      }> = [];

      let mergedShaderUpdate: { forceCode?: string; colorCode?: string; label?: string } | undefined;
      let mergedPhysicsUpdate: Record<string, unknown> | undefined;
      let mergedCustomTargets: number[] | undefined;
      let finalReplyText = '';

      for (let turn = 0; turn < 4; turn++) {
        const response = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: mcpToolDeclarations }],
          },
        });

        const candidateContent = response.candidates?.[0]?.content;
        const calls = response.functionCalls;

        if (calls && calls.length > 0 && candidateContent) {
          contents.push(candidateContent);
          const responseParts: Array<{
            functionResponse: {
              id?: string;
              name: string;
              response: Record<string, unknown>;
            };
          }> = [];

          for (const call of calls) {
            const name = call.name || 'unknown';
            const args = (call.args as Record<string, unknown>) || {};
            const exec = executeMcpTool(name, args);

            toolCallRecords.push({
              id: call.id || `${name}-${Date.now()}-${toolCallRecords.length}`,
              toolName: name,
              args,
              resultSummary: exec.resultSummary,
              durationMs: exec.durationMs,
              status: exec.status,
              timestamp: new Date().toISOString(),
            });

            if (exec.payload.shaderUpdate) {
              mergedShaderUpdate = {
                ...(mergedShaderUpdate || {}),
                ...exec.payload.shaderUpdate,
              };
            }
            if (exec.payload.physicsUpdate) {
              mergedPhysicsUpdate = {
                ...(mergedPhysicsUpdate || {}),
                ...exec.payload.physicsUpdate,
              };
            }
            if (exec.payload.customTargets) {
              mergedCustomTargets = exec.payload.customTargets;
            }

            responseParts.push({
              functionResponse: {
                id: call.id,
                name,
                response: {
                  status: exec.status,
                  summary: exec.resultSummary,
                  dataOutput: exec.payload.dataOutput ?? null,
                },
              },
            });
          }

          contents.push({
            role: 'user',
            parts: responseParts,
          });
          continue;
        }

        finalReplyText = (response.text || '').trim();
        break;
      }

      if (!finalReplyText) {
        finalReplyText = toolCallRecords.length > 0
          ? `Executed ${toolCallRecords.map((t) => t.toolName).join(' and ')} on the particle field.`
          : 'Particle field ready.';
      }

      // Step 3: Synthesize Piper-style vocal response via Gemini TTS
      const tts = await synthesizePiperStyleSpeech(ai, finalReplyText, voiceName);

      return res.json({
        transcript,
        replyText: finalReplyText,
        audioBase64: tts.audioBase64,
        audioMimeType: tts.audioMimeType,
        ttsError: tts.ttsError,
        toolCalls: toolCallRecords,
        shaderUpdate: mergedShaderUpdate,
        physicsUpdate: mergedPhysicsUpdate,
        customTargets: mergedCustomTargets,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Agent command failed';
      return res.status(500).json({ error: message });
    }
  });

  const httpServer = http.createServer(app);

  // Vite dev middleware or static production build
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Kinetix Chant server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
