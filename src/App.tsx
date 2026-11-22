import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  BEHAVIORS,
  DEFAULT_PARAMS,
  LIMITS,
  MAX_PROMPT_CHARS,
  PRESETS,
  SHAPES,
  type VisualParams,
  type ResultSource,
} from '../shared/params';
import { ParticleEngine, type EngineStats, type PointerMode } from './engine/ParticleEngine';
import { ApiError, fetchStatus, visualizeStream, type LlmStatus } from './lib/api';
import { describeStatus } from './lib/status';

const isSmallDevice = () =>
  typeof window !== 'undefined' && (matchMedia('(pointer: coarse)').matches || window.innerWidth < 768);

const MODES: Array<{ id: PointerMode; label: string; hint: string }> = [
  { id: 'attract', label: 'Attract', hint: 'Press and drag to pull particles' },
  { id: 'repel', label: 'Repel', hint: 'Press and drag to push particles away' },
  { id: 'swirl', label: 'Swirl', hint: 'Press and drag to stir a vortex' },
  { id: 'orbit', label: 'Orbit', hint: 'Drag to rotate the camera' },
];

interface Reply {
  text: string;
  source?: ResultSource;
  notice?: string;
  error?: boolean;
}

function Slider(props: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const { id, label, value, min, max, step, format, onChange } = props;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-slate-300">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="tabular-nums text-slate-400">
          {format ? format(value) : value.toFixed(2)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        className="plm-range w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<ParticleEngine | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSendRef = useRef({ text: '', at: 0 });
  const small = useRef(isSmallDevice()).current;
  const maxParticles = small ? 60_000 : 150_000;

  const [params, setParams] = useState<VisualParams>(DEFAULT_PARAMS);
  const [count, setCount] = useState(small ? 16_000 : 60_000);
  const [mode, setMode] = useState<PointerMode>('attract');
  const [autoQuality, setAutoQuality] = useState(true);
  const [autoRotate, setAutoRotate] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(
    () => typeof window !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [panelOpen, setPanelOpen] = useState(!small);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState('');
  const [reply, setReply] = useState<Reply>({ text: 'Describe a scene, or pick a preset. Drag on the particles to play.' });
  const [stats, setStats] = useState<EngineStats>({ fps: 0, count: 0, targetCount: 0 });
  const [status, setStatus] = useState<LlmStatus>({ mode: 'unknown' });
  const [glError, setGlError] = useState<string | null>(null);
  const [contextLost, setContextLost] = useState(false);

  // Engine lifecycle
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: ParticleEngine;
    try {
      engine = new ParticleEngine(canvas, DEFAULT_PARAMS, {
        maxParticles,
        initialCount: count,
        autoQuality: true,
        reducedMotion,
        onStats: setStats,
        onContextChange: setContextLost,
      });
    } catch (err) {
      setGlError(err instanceof Error ? err.message : 'WebGL2 failed to start.');
      return;
    }
    engineRef.current = engine;
    engine.start();
    const onVis = () => (document.hidden ? engine.stop() : engine.start());
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      engine.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => engineRef.current?.setParams(params), [params]);
  useEffect(() => engineRef.current?.setCount(count), [count]);
  useEffect(() => engineRef.current?.setMode(mode), [mode]);
  useEffect(() => engineRef.current?.setAutoQuality(autoQuality), [autoQuality]);
  // Order matters: apply reduced motion first, then the effective auto-rotate (user choice AND not reduced).
  useEffect(() => {
    engineRef.current?.setReducedMotion(reducedMotion);
    engineRef.current?.setAutoRotate(autoRotate && !reducedMotion);
  }, [autoRotate, reducedMotion]);

  useEffect(() => {
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const fn = () => setReducedMotion(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);

  // LLM status polling (server-side probe; the browser never talks to Ollama)
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await fetchStatus();
      if (alive) setStatus(s);
    };
    void tick();
    const id = window.setInterval(tick, 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setPartial('');
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && abortRef.current) {
        cancel();
        setReply({ text: 'Cancelled.' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cancel]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setReply({ text: 'Type something to visualize first.', error: true });
        return;
      }
      // Ignore an identical re-submit within 400 ms (double tap / double Enter).
      const now = performance.now();
      if (lastSendRef.current.text === trimmed && now - lastSendRef.current.at < 400 && abortRef.current) return;
      lastSendRef.current = { text: trimmed, at: now };
      abortRef.current?.abort(); // fast repeated sends: newest wins
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setBusy(true);
      setPartial('');
      try {
        const result = await visualizeStream(trimmed.slice(0, MAX_PROMPT_CHARS), ctrl.signal, (t) => {
          if (abortRef.current === ctrl) setPartial(t);
        });
        if (abortRef.current !== ctrl) return;
        setParams(result.params);
        setReply({ text: result.reply, source: result.source, notice: result.notice });
        // The server merges what this chat experienced into its status, so re-read it every time.
        void fetchStatus().then(setStatus);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setReply({ text: err instanceof ApiError ? err.message : 'Something went wrong.', error: true });
      } finally {
        if (abortRef.current === ctrl) {
          abortRef.current = null;
          setBusy(false);
          setPartial('');
        }
      }
    },
    [],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(prompt);
  };

  const update = <K extends keyof VisualParams>(key: K, value: VisualParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  const { label: statusLabel, tone } = describeStatus(status);
  const statusColor = tone === 'green' ? 'bg-emerald-400' : tone === 'grey' ? 'bg-slate-400' : 'bg-amber-400';

  return (
    <div className="relative h-full w-full overflow-hidden text-slate-100" style={{ backgroundColor: params.background }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none select-none"
        aria-label={`Particle visualizer showing ${params.label}. ${MODES.find((m) => m.id === mode)?.hint}.`}
        role="img"
      />

      {glError && (
        <div role="alert" className="absolute inset-0 grid place-items-center p-6 text-center">
          <p className="max-w-md rounded-xl bg-black/70 p-4 text-sm">{glError} Try a recent Chrome, Edge, Firefox or Safari.</p>
        </div>
      )}
      {contextLost && !glError && (
        <div role="status" className="absolute inset-x-0 top-20 mx-auto w-fit rounded-lg bg-black/70 px-3 py-2 text-xs">
          Graphics context lost, restoring…
        </div>
      )}

      {/* Header */}
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3 sm:p-4">
        <div className="pointer-events-auto min-w-0 rounded-xl bg-black/45 px-3 py-2 backdrop-blur-md">
          <h1 className="text-sm font-semibold tracking-wide sm:text-base">Particle-LM</h1>
          <p className="flex items-center gap-1.5 truncate text-[11px] text-slate-300" title={statusLabel}>
            <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${statusColor}`} aria-hidden="true" />
            <span className="truncate" data-testid="llm-status">{statusLabel}</span>
          </p>
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          <span className="hidden rounded-lg bg-black/45 px-2 py-1 text-[11px] tabular-nums text-slate-300 backdrop-blur-md sm:inline" data-testid="fps">
            {stats.fps} fps · {(stats.count / 1000).toFixed(1)}k
          </span>
          <button
            type="button"
            className="plm-btn"
            aria-expanded={panelOpen}
            aria-controls="controls-panel"
            onClick={() => setPanelOpen((o) => !o)}
          >
            {panelOpen ? 'Hide controls' : 'Controls'}
          </button>
        </div>
      </header>

      {/* Interaction mode */}
      <div
        role="radiogroup"
        aria-label="Pointer interaction"
        className="absolute left-1/2 top-[4.25rem] flex -translate-x-1/2 gap-1 rounded-xl bg-black/45 p-1 backdrop-blur-md sm:top-4"
      >
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={mode === m.id}
            title={m.hint}
            onClick={() => setMode(m.id)}
            className={`min-h-9 rounded-lg px-2.5 text-xs font-medium transition-colors sm:px-3 ${
              mode === m.id ? 'bg-white/90 text-slate-900' : 'text-slate-200 hover:bg-white/10'
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Controls panel */}
      {panelOpen && (
        <aside
          id="controls-panel"
          aria-label="Visual controls"
          className="absolute inset-x-2 bottom-[11.5rem] max-h-[45vh] overflow-y-auto overscroll-contain rounded-2xl bg-black/65 p-4 backdrop-blur-md sm:inset-x-auto sm:right-4 sm:top-16 sm:bottom-auto sm:max-h-[calc(100vh-15rem)] sm:w-72"
        >
          <div className="space-y-3">
            <Slider id="s-count" label="Particles" value={count} min={2000} max={maxParticles} step={1000}
              format={(v) => `${Math.round(v / 1000)}k`} onChange={setCount} />
            <Slider id="s-speed" label="Speed" value={params.speed} min={LIMITS.speed[0]} max={LIMITS.speed[1]} step={0.05}
              onChange={(v) => update('speed', v)} />
            <Slider id="s-size" label="Size" value={params.size} min={LIMITS.size[0]} max={LIMITS.size[1]} step={0.05}
              onChange={(v) => update('size', v)} />
            <Slider id="s-force" label="Touch force" value={params.force} min={LIMITS.force[0]} max={LIMITS.force[1]} step={0.05}
              onChange={(v) => update('force', v)} />
            <Slider id="s-turb" label="Turbulence" value={params.turbulence} min={LIMITS.turbulence[0]} max={LIMITS.turbulence[1]} step={0.05}
              onChange={(v) => update('turbulence', v)} />
            <Slider id="s-hold" label="Shape hold" value={params.shapeStrength} min={0} max={1} step={0.01}
              onChange={(v) => update('shapeStrength', v)} />

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-xs text-slate-300">
                <span>Shape</span>
                <select className="plm-select" value={params.shape} onChange={(e) => update('shape', e.target.value as VisualParams['shape'])}>
                  {SHAPES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs text-slate-300">
                <span>Motion</span>
                <select className="plm-select" value={params.behavior} onChange={(e) => update('behavior', e.target.value as VisualParams['behavior'])}>
                  {BEHAVIORS.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </label>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(['primary', 'accent', 'background'] as const).map((k) => (
                <label key={k} className="space-y-1 text-xs capitalize text-slate-300">
                  <span>{k === 'background' ? 'Backdrop' : k}</span>
                  <input type="color" className="plm-color" value={params[k]} onChange={(e) => update(k, e.target.value)} />
                </label>
              ))}
            </div>

            <div className="space-y-2 text-xs text-slate-300">
              <label className="flex min-h-11 items-center justify-between gap-2">
                <span>Auto quality (keeps it smooth)</span>
                <input type="checkbox" checked={autoQuality} onChange={(e) => setAutoQuality(e.target.checked)} />
              </label>
              <label className="flex min-h-11 items-center justify-between gap-2">
                <span>Auto-rotate</span>
                <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} />
              </label>
              <label className="flex min-h-11 items-center justify-between gap-2">
                <span>Reduced motion</span>
                <input type="checkbox" checked={reducedMotion} onChange={(e) => setReducedMotion(e.target.checked)} />
              </label>
            </div>
            <div className="flex gap-2">
              <button type="button" className="plm-btn flex-1" onClick={() => engineRef.current?.resetCamera()}>Reset view</button>
              <button type="button" className="plm-btn flex-1" onClick={() => setParams(DEFAULT_PARAMS)}>Reset scene</button>
            </div>
            <p className="text-[11px] text-slate-400 sm:hidden">{stats.fps} fps · {(stats.count / 1000).toFixed(1)}k particles</p>
          </div>
        </aside>
      )}

      {/* Prompt dock */}
      <section aria-label="Prompt" className="absolute inset-x-2 bottom-2 mx-auto max-w-2xl space-y-2 sm:bottom-4">
        <div className="no-scrollbar chip-row flex gap-1.5 overflow-x-auto pb-0.5" aria-label="Presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="shrink-0 rounded-full bg-black/50 px-3 py-1.5 text-xs text-slate-200 backdrop-blur-md hover:bg-white/15"
              onClick={() => {
                setParams(p.params);
                setPrompt(p.prompt);
                setReply({ text: `Preset: ${p.params.label}.` });
              }}
            >
              {p.name}
            </button>
          ))}
        </div>

        <div className="rounded-2xl bg-black/60 p-2 backdrop-blur-md">
          {status.mode === 'misconfigured' && status.notice && (
            <p role="alert" className="px-2 pb-1 text-[11px] text-amber-300" data-testid="config-notice">
              {status.notice}
            </p>
          )}
          <p
            className={`min-h-[2.5rem] whitespace-pre-wrap break-words px-2 py-1 text-sm ${reply.error ? 'text-amber-300' : 'text-slate-100'}`}
            aria-live="polite"
            data-testid="reply"
          >
            {busy ? partial || 'Thinking…' : reply.text}
            {!busy && reply.source && (
              <span className="ml-2 rounded bg-white/10 px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wide text-slate-300" data-testid="source">
                {reply.source === 'llm' ? 'local llm' : 'offline'}
              </span>
            )}
          </p>
          {!busy && reply.notice && (
            <p className="px-2 pb-1 text-[11px] text-amber-200" data-testid="notice">{reply.notice}</p>
          )}
          <form onSubmit={onSubmit} className="flex items-end gap-2">
            <label htmlFor="prompt" className="sr-only">Describe a particle scene</label>
            <input
              id="prompt"
              name="prompt"
              type="text"
              autoComplete="off"
              enterKeyHint="send"
              maxLength={MAX_PROMPT_CHARS}
              placeholder="e.g. galaxy spiral in neon pink"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-white/5 px-3 text-base text-slate-100 placeholder:text-slate-400 focus:border-cyan-300/60 focus:outline-none sm:text-sm"
            />
            {busy ? (
              <button
                key="cancel"
                type="button"
                className="plm-btn min-h-11 bg-amber-400/90 text-slate-900"
                onClick={(e) => {
                  // distinct key + preventDefault: never let the swap to "Send" submit the form
                  e.preventDefault();
                  cancel();
                  setReply({ text: 'Cancelled.' });
                }}
              >
                Cancel
              </button>
            ) : (
              <button key="send" type="submit" className="plm-btn min-h-11 bg-cyan-300/90 text-slate-900 hover:bg-cyan-200">
                Send
              </button>
            )}
          </form>
        </div>
      </section>
    </div>
  );
}
