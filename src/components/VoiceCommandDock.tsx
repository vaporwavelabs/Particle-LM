import React, { useState } from 'react';
import {
  Loader2,
  Mic,
  MicOff,
  Radio,
  RotateCcw,
  Send,
  Square,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import { AudioMetrics } from '../types/simulation';

interface VoiceCommandDockProps {
  micActive: boolean;
  recordingChant: boolean;
  ttsPlaying: boolean;
  muted: boolean;
  busy: boolean;
  audioMetrics: AudioMetrics;
  lastTranscript: string;
  lastReply: string;
  lastAudioBase64?: string;
  errorMessage: string | null;
  onToggleMic: () => void;
  onToggleRecordChant: () => void;
  onSubmitPrompt: (prompt: string) => void;
  onToggleMute: () => void;
  onReplayAudio: () => void;
  onDismissBanner: () => void;
}

const QUICK_DIRECTIVES = [
  { label: 'Spiral Vortex', prompt: 'Mutate the GLSL force shader into a luminous twin-arm spiral galaxy vortex reactive to vocal bass.' },
  { label: 'Lorenz MCP', prompt: 'Run MCP data processor code to compute a 3D Lorenz strange attractor and morph particles into it.' },
  { label: 'DNA Helix', prompt: 'Morph particles into a pulsing DNA helix that ripples along its spine during high-pitch voice chants.' },
  { label: 'Release Fluid', prompt: 'Release particles back into free obsidian curl fluid with golden amber cadence flares.' },
];

export function VoiceCommandDock({
  micActive,
  recordingChant,
  ttsPlaying,
  muted,
  busy,
  audioMetrics,
  lastTranscript,
  lastReply,
  lastAudioBase64,
  errorMessage,
  onToggleMic,
  onToggleRecordChant,
  onSubmitPrompt,
  onToggleMute,
  onReplayAudio,
  onDismissBanner,
}: VoiceCommandDockProps) {
  const [input, setInput] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    onSubmitPrompt(trimmed);
    setInput('');
  };

  const showAudioStrip = micActive || recordingChant || ttsPlaying;
  const showBanner = Boolean(errorMessage || lastReply);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-20 flex flex-col items-center px-4">
      <div className="pointer-events-auto w-full max-w-3xl rounded-xl border border-[#1E293B] bg-[#0B0E17]/90 p-3 backdrop-blur-md">
        {/* Spoken Response / Error Transcript Banner */}
        {showBanner && (
          <div className="mb-2.5 flex items-start justify-between gap-3 border-b border-[#1E293B] pb-2.5">
            <div className="min-w-0 flex-1 space-y-1">
              {errorMessage ? (
                <p className="text-xs font-medium text-rose-400">
                  Error: {errorMessage}
                </p>
              ) : (
                <>
                  {lastTranscript && (
                    <p className="truncate font-mono text-[11px] text-slate-400">
                      Chant: {lastTranscript}
                    </p>
                  )}
                  <p className="text-xs leading-relaxed text-slate-200">
                    {lastReply}
                  </p>
                </>
              )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {lastAudioBase64 && (
                <button
                  type="button"
                  onClick={onReplayAudio}
                  title="Replay synthesized voice"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-cyan-300 focus-visible:outline-2 focus-visible:outline-cyan-400"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onToggleMute}
                title={muted ? 'Unmute voice responses' : 'Mute voice responses'}
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-cyan-400"
              >
                {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={onDismissBanner}
                title="Dismiss message"
                className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-2 focus-visible:outline-cyan-400"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Real-Time Audio Spectrum & Cadence Visualizer */}
        {showAudioStrip && (
          <div className="mb-2.5 flex items-center justify-between gap-4 border-b border-[#1E293B] pb-2.5">
            <div className="flex h-6 flex-1 items-end gap-[3px]">
              {audioMetrics.spectrum.map((val, idx) => {
                const scale = Math.max(0.08, val);
                const isPeak = idx > 18 || val > 0.65;
                return (
                  <div
                    key={idx}
                    className={`h-full flex-1 origin-bottom rounded-[1px] transition-transform duration-75 ${
                      isPeak ? 'bg-amber-400/90' : 'bg-cyan-400/85'
                    }`}
                    style={{ transform: `scaleY(${scale})` }}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-3 font-mono text-[11px] tabular-nums text-slate-300 shrink-0">
              <span>
                {audioMetrics.source === 'tts'
                  ? 'TTS Output'
                  : recordingChant
                    ? 'Recording Chant'
                    : 'Live Mic'}
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>{audioMetrics.pitchHz > 0 ? `${audioMetrics.pitchHz} Hz` : '-- Hz'}</span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span>Cadence {Math.round(audioMetrics.cadence * 100)}%</span>
            </div>
          </div>
        )}

        {/* Primary Input & Voice Chant Controls */}
        <form onSubmit={handleSubmit} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
          <button
            type="button"
            onClick={onToggleMic}
            title={micActive ? 'Disable live microphone reactivity' : 'Enable live microphone FFT reactivity'}
            className={`flex min-h-[40px] items-center gap-1.5 whitespace-nowrap shrink-0 rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-cyan-400 ${
              micActive
                ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-300'
                : 'border-[#1E293B] bg-[#0F141F] text-slate-300 hover:border-slate-600 hover:text-slate-100'
            }`}
          >
            {micActive ? <Mic className="h-3.5 w-3.5" /> : <MicOff className="h-3.5 w-3.5" />}
            <span>{micActive ? 'Mic Live' : 'Live Mic'}</span>
          </button>

          <button
            type="button"
            onClick={onToggleRecordChant}
            disabled={busy}
            title={recordingChant ? 'Stop recording and execute chant' : 'Record a voice chant or spoken shader command'}
            className={`flex min-h-[40px] items-center gap-1.5 whitespace-nowrap shrink-0 rounded-lg border px-3 py-2 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-amber-400 disabled:opacity-50 ${
              recordingChant
                ? 'border-amber-500/70 bg-amber-500/20 text-amber-300'
                : 'border-[#1E293B] bg-[#0F141F] text-slate-300 hover:border-amber-500/40 hover:text-amber-200'
            }`}
          >
            {recordingChant ? (
              <>
                <Square className="h-3.5 w-3.5 fill-current" />
                <span>Send Chant</span>
              </>
            ) : (
              <>
                <Radio className="h-3.5 w-3.5" />
                <span>Voice Chant</span>
              </>
            )}
          </button>

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Command MCP to mutate shaders, run code, or morph..."
            disabled={busy}
            className="min-h-[40px] min-w-0 flex-1 rounded-lg border border-[#1E293B] bg-[#07090E] px-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:border-cyan-500/60 focus:outline-none disabled:opacity-60"
          />

          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex min-h-[40px] items-center gap-1.5 whitespace-nowrap shrink-0 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors duration-150 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500 focus-visible:outline-2 focus-visible:outline-cyan-400"
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                <span>Running</span>
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                <span>Execute</span>
              </>
            )}
          </button>
        </form>

        {/* Quick Preset Directives */}
        <div className="mt-2 flex items-center gap-2 overflow-x-auto pt-1">
          <span className="whitespace-nowrap text-[11px] text-slate-500">Presets:</span>
          {QUICK_DIRECTIVES.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={busy}
              onClick={() => onSubmitPrompt(item.prompt)}
              className="whitespace-nowrap shrink-0 rounded-md border border-[#1E293B] bg-[#07090E] px-2.5 py-1 text-[11px] font-medium text-slate-300 transition-colors hover:border-cyan-500/40 hover:text-cyan-300 disabled:opacity-50"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
