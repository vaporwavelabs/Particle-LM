import React, { useCallback, useEffect, useRef, useState } from 'react';
import { McpInspectorDrawer } from './components/McpInspectorDrawer';
import { TopBar } from './components/TopBar';
import { VoiceCommandDock } from './components/VoiceCommandDock';
import { AudioChantEngine } from './engine/AudioChantEngine';
import { ParticleEngine } from './engine/ParticleEngine';
import {
  AgentCommandResponse,
  AudioMetrics,
  DEFAULT_COLOR_CODE,
  DEFAULT_FORCE_CODE,
  DEFAULT_PHYSICS,
  McpToolCallRecord,
  PhysicsConfig,
  ShaderCodeConfig,
  StudioMode,
  VoicePersona,
} from './types/simulation';

const EMPTY_AUDIO: AudioMetrics = {
  bass: 0,
  mid: 0,
  treble: 0,
  cadence: 0,
  pitchHz: 0,
  level: 0,
  spectrum: new Array(32).fill(0),
  source: 'idle',
};

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<ParticleEngine | null>(null);
  const audioRef = useRef<AudioChantEngine | null>(null);

  const [activeMode, setActiveMode] = useState<StudioMode>('fluid');
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<'physics' | 'shaders' | 'mcp'>('physics');

  const [physics, setPhysics] = useState<PhysicsConfig>(DEFAULT_PHYSICS);
  const [shaderConfig, setShaderConfig] = useState<ShaderCodeConfig>({
    forceCode: DEFAULT_FORCE_CODE,
    colorCode: DEFAULT_COLOR_CODE,
    label: 'Default Harmonic Field',
  });
  const [shaderError, setShaderError] = useState<string | null>(null);

  const [fps, setFps] = useState(60);
  const [cursorCoords, setCursorCoords] = useState<[number, number]>([0, 0]);
  const [contextLost, setContextLost] = useState(false);
  const [webglUnsupported, setWebglUnsupported] = useState<string | null>(null);

  const [micActive, setMicActive] = useState(false);
  const [recordingChant, setRecordingChant] = useState(false);
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ttsBusy, setTtsBusy] = useState(false);
  const [voicePersona, setVoicePersona] = useState<VoicePersona>('Kore');

  const [audioMetrics, setAudioMetrics] = useState<AudioMetrics>(EMPTY_AUDIO);
  const [lastTranscript, setLastTranscript] = useState('');
  const [lastReply, setLastReply] = useState('');
  const [lastAudioBase64, setLastAudioBase64] = useState<string | undefined>(undefined);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [mcpLogs, setMcpLogs] = useState<McpToolCallRecord[]>([]);

  // Initialize WebGL2 ParticleEngine + AudioChantEngine
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const audio = new AudioChantEngine();
    audioRef.current = audio;

    let engine: ParticleEngine;
    try {
      engine = new ParticleEngine(canvas, DEFAULT_PHYSICS, {
        onContextStatus: (lost) => setContextLost(lost),
        onFpsUpdate: (measured) => setFps(measured),
      });
      engineRef.current = engine;
    } catch (err) {
      setWebglUnsupported(
        err instanceof Error ? err.message : 'WebGL2 is unavailable in this browser.'
      );
      return () => {
        audio.dispose();
      };
    }

    const rect = container.getBoundingClientRect();
    engine.resize(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        engine.resize(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(container);

    let lastHudSync = 0;
    engine.start(() => {
      const metrics = audio.sampleMetrics();
      const now = performance.now();
      if (now - lastHudSync > 55) {
        lastHudSync = now;
        const playing = audio.isTtsPlaying();
        setTtsPlaying((prev) => (prev !== playing ? playing : prev));
        if (metrics.source !== 'idle') {
          setAudioMetrics(metrics);
        }
      }
      return metrics;
    });

    return () => {
      observer.disconnect();
      engine.dispose();
      audio.dispose();
      engineRef.current = null;
      audioRef.current = null;
    };
  }, []);

  const updatePhysics = useCallback((patch: Partial<PhysicsConfig>) => {
    setPhysics((prev) => {
      const next = { ...prev, ...patch };
      engineRef.current?.updateConfig(patch);
      return next;
    });
  }, []);

  const applyShaders = useCallback(
    (nextForce: string, nextColor: string, label: string) => {
      if (!engineRef.current) return false;
      const result = engineRef.current.updateShaders(nextForce, nextColor);
      if (!result.ok) {
        setShaderError(result.error || 'GLSL compilation failed.');
        return false;
      }
      setShaderError(null);
      setShaderConfig({ forceCode: nextForce, colorCode: nextColor, label });
      return true;
    },
    []
  );

  const handleToggleMic = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    setErrorMessage(null);
    if (micActive) {
      audio.stopMic();
      setMicActive(false);
      setRecordingChant(false);
      setAudioMetrics(EMPTY_AUDIO);
    } else {
      try {
        await audio.startMic();
        setMicActive(true);
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Microphone permission denied.'
        );
      }
    }
  }, [micActive]);

  const sendAgentCommand = useCallback(
    async (payload: { text?: string; audioBase64?: string; audioMimeType?: string }) => {
      setBusy(true);
      setErrorMessage(null);
      try {
        const res = await fetch('/api/agent/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            currentShader: {
              forceCode: shaderConfig.forceCode,
              colorCode: shaderConfig.colorCode,
            },
            currentPhysics: physics,
            voiceName: voicePersona,
          }),
        });

        const data = (await res.json()) as AgentCommandResponse;
        if (!res.ok) {
          throw new Error(data.error || `Server returned ${res.status}`);
        }

        setLastTranscript(data.transcript || '');
        setLastReply(data.replyText || '');

        if (data.toolCalls && data.toolCalls.length > 0) {
          setMcpLogs((prev) => [...data.toolCalls.slice().reverse(), ...prev].slice(0, 40));
        }

        if (data.customTargets && data.customTargets.length >= 3) {
          engineRef.current?.setCustomTargets(data.customTargets, 'custom');
          setPhysics((prev) => ({
            ...prev,
            formation: 'custom',
            morphStrength: data.physicsUpdate?.morphStrength ?? Math.max(prev.morphStrength, 0.76),
          }));
          setActiveMode('morph');
        }

        if (data.physicsUpdate) {
          updatePhysics(data.physicsUpdate);
          if (data.physicsUpdate.formation && data.physicsUpdate.formation !== 'fluid') {
            setActiveMode('morph');
          }
        }

        if (data.shaderUpdate) {
          const nextForce = data.shaderUpdate.forceCode ?? shaderConfig.forceCode;
          const nextColor = data.shaderUpdate.colorCode ?? shaderConfig.colorCode;
          const nextLabel = data.shaderUpdate.label ?? 'AI Mutated Shader';
          const ok = applyShaders(nextForce, nextColor, nextLabel);
          if (!ok) {
            setErrorMessage('AI shader mutation had a GLSL syntax issue; kept active shader.');
          }
        }

        if (data.audioBase64) {
          setLastAudioBase64(data.audioBase64);
          if (!muted && audioRef.current) {
            void audioRef.current.playSynthesizedAudio(data.audioBase64);
          }
        }
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : 'Failed to process command.');
      } finally {
        setBusy(false);
      }
    },
    [applyShaders, muted, physics, shaderConfig.colorCode, shaderConfig.forceCode, updatePhysics, voicePersona]
  );

  const handleToggleRecordChant = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio || busy) return;
    setErrorMessage(null);

    if (!recordingChant) {
      try {
        await audio.startChantCapture();
        setMicActive(true);
        setRecordingChant(true);
        setActiveMode('chant');
      } catch (err) {
        setErrorMessage(
          err instanceof Error ? err.message : 'Could not start voice chant recording.'
        );
      }
    } else {
      setRecordingChant(false);
      const captured = await audio.stopChantCapture();
      if (!captured) {
        setErrorMessage('Voice chant was too short—try holding or speaking for a moment.');
        return;
      }
      await sendAgentCommand({
        audioBase64: captured.base64,
        audioMimeType: captured.mimeType,
      });
    }
  }, [busy, recordingChant, sendAgentCommand]);

  const handleRunMcpCode = useCallback(
    async (code: string) => {
      setErrorMessage(null);
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: {
            name: 'run_data_processor',
            arguments: { code, morphStrength: 0.8 },
          },
        }),
      });
      const data = await res.json();
      const exec = data?.result?.execution;
      if (exec) {
        setMcpLogs((prev) => [
          {
            id: `manual-${Date.now()}`,
            toolName: exec.toolName,
            args: exec.args,
            resultSummary: exec.resultSummary,
            durationMs: exec.durationMs,
            status: exec.status,
            timestamp: new Date().toISOString(),
          },
          ...prev,
        ]);

        if (exec.status === 'error') {
          setErrorMessage(exec.resultSummary);
          return;
        }
        if (exec.payload?.customTargets) {
          engineRef.current?.setCustomTargets(exec.payload.customTargets, 'custom');
          updatePhysics({ formation: 'custom', morphStrength: 0.8 });
          setActiveMode('morph');
        }
      }
    },
    [updatePhysics]
  );

  const handleTestVoice = useCallback(async () => {
    setTtsBusy(true);
    setErrorMessage(null);
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `Voice synthesis active using ${voicePersona}. Particle fluid harmonics locked and ready for your chant.`,
          voiceName: voicePersona,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Voice test failed.');
      }
      if (data.audioBase64) {
        setLastAudioBase64(data.audioBase64);
        setLastReply(`Voice persona ${voicePersona} calibrated.`);
        if (!muted) {
          await audioRef.current?.playSynthesizedAudio(data.audioBase64);
        }
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'TTS test failed.');
    } finally {
      setTtsBusy(false);
    }
  }, [muted, voicePersona]);

  const handleSelectMode = useCallback(
    (mode: StudioMode) => {
      setActiveMode(mode);
      if (mode === 'fluid') {
        updatePhysics({ formation: 'fluid', morphStrength: 0 });
      } else if (mode === 'morph') {
        const nextForm = physics.formation === 'fluid' ? 'torus' : physics.formation;
        updatePhysics({ formation: nextForm, morphStrength: 0.78 });
      } else if (mode === 'chant') {
        if (!micActive) {
          void handleToggleMic();
        }
      } else if (mode === 'shader') {
        setInspectorTab('shaders');
        setInspectorOpen(true);
      }
    },
    [handleToggleMic, micActive, physics.formation, updatePhysics]
  );

  const handleResetAll = useCallback(() => {
    setPhysics(DEFAULT_PHYSICS);
    engineRef.current?.updateConfig(DEFAULT_PHYSICS);
    applyShaders(DEFAULT_FORCE_CODE, DEFAULT_COLOR_CODE, 'Default Harmonic Field');
    setActiveMode('fluid');
    setErrorMessage(null);
  }, [applyShaders]);

  // Pointer tracking for fluid wakes, attraction, and repulsion
  const updateCursorFromPointer = (e: React.PointerEvent<HTMLCanvasElement>, downOverride?: number) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ny = -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    let downState = 0;
    if (typeof downOverride === 'number') {
      downState = downOverride;
    } else if (e.buttons === 1) {
      downState = e.shiftKey ? -1 : 1;
    } else if (e.buttons === 2) {
      downState = -1;
    }
    engineRef.current?.setCursor(nx, ny, downState);
    setCursorCoords([nx, ny]);
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#07090E] text-slate-100">
      <TopBar
        activeMode={activeMode}
        inspectorOpen={inspectorOpen}
        onSelectMode={handleSelectMode}
        onToggleInspector={() => setInspectorOpen((v) => !v)}
      />

      <main ref={containerRef} className="relative flex-1 overflow-hidden">
        <canvas
          ref={canvasRef}
          onContextMenu={(e) => e.preventDefault()}
          onPointerMove={(e) => updateCursorFromPointer(e)}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            const polarity = e.button === 2 || e.shiftKey ? -1 : 1;
            updateCursorFromPointer(e, polarity);
          }}
          onPointerUp={(e) => updateCursorFromPointer(e, 0)}
          onPointerLeave={() => {
            engineRef.current?.setCursor(0, 0, 0);
          }}
          className="block h-full w-full cursor-crosshair touch-none"
        />

        {/* Quiet Scientific Telemetry Readout (unboxed, tabular numerals, zero pills) */}
        <div className="pointer-events-none absolute left-5 top-4 z-10 flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums text-slate-400">
          <span className="text-slate-200">{physics.particleCount.toLocaleString()} pts</span>
          <span aria-hidden="true">·</span>
          <span>{fps} fps</span>
          <span aria-hidden="true">·</span>
          <span className="capitalize">{physics.formation}</span>
          <span aria-hidden="true">·</span>
          <span>
            {cursorCoords[0].toFixed(2)}, {cursorCoords[1].toFixed(2)}
          </span>
          <span aria-hidden="true" className="hidden sm:inline">·</span>
          <span className="hidden sm:inline text-slate-500">
            Drag attract · Right-click repel
          </span>
        </div>

        {/* WebGL Fallback / Context Lost Overlay */}
        {(webglUnsupported || contextLost) && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#07090E]/90 p-6">
            <div className="max-w-md rounded-xl border border-[#1E293B] bg-[#0B0E17] p-6 text-center space-y-2">
              <h2 className="text-base font-semibold text-slate-100">
                {contextLost ? 'WebGL Context Paused' : 'WebGL2 Unavailable'}
              </h2>
              <p className="text-xs leading-relaxed text-slate-400">
                {webglUnsupported ||
                  'Waiting for GPU context restoration to resume the 65,536-particle fluid simulation.'}
              </p>
            </div>
          </div>
        )}

        <VoiceCommandDock
          micActive={micActive}
          recordingChant={recordingChant}
          ttsPlaying={ttsPlaying}
          muted={muted}
          busy={busy}
          audioMetrics={audioMetrics}
          lastTranscript={lastTranscript}
          lastReply={lastReply}
          lastAudioBase64={lastAudioBase64}
          errorMessage={errorMessage}
          onToggleMic={handleToggleMic}
          onToggleRecordChant={handleToggleRecordChant}
          onSubmitPrompt={(prompt) => void sendAgentCommand({ text: prompt })}
          onToggleMute={() => {
            const next = !muted;
            setMuted(next);
            audioRef.current?.setMuted(next);
          }}
          onReplayAudio={() => {
            if (lastAudioBase64 && !muted) {
              void audioRef.current?.playSynthesizedAudio(lastAudioBase64);
            }
          }}
          onDismissBanner={() => {
            setLastReply('');
            setLastTranscript('');
            setErrorMessage(null);
          }}
        />

        <McpInspectorDrawer
          open={inspectorOpen}
          initialTab={inspectorTab}
          physics={physics}
          shaderConfig={shaderConfig}
          shaderError={shaderError}
          voicePersona={voicePersona}
          mcpLogs={mcpLogs}
          ttsBusy={ttsBusy}
          onClose={() => setInspectorOpen(false)}
          onUpdatePhysics={updatePhysics}
          onApplyShaders={(f, c, l) => {
            applyShaders(f, c, l);
          }}
          onRunMcpCode={handleRunMcpCode}
          onChangeVoicePersona={setVoicePersona}
          onTestVoice={handleTestVoice}
          onResetAll={handleResetAll}
        />
      </main>
    </div>
  );
}
