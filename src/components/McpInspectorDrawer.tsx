import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Play, RotateCcw, Terminal, X } from 'lucide-react';
import {
  DEFAULT_COLOR_CODE,
  DEFAULT_FORCE_CODE,
  FormationId,
  McpToolCallRecord,
  PhysicsConfig,
  ShaderCodeConfig,
  VoicePersona,
} from '../types/simulation';

interface McpInspectorDrawerProps {
  open: boolean;
  initialTab?: 'physics' | 'shaders' | 'mcp';
  physics: PhysicsConfig;
  shaderConfig: ShaderCodeConfig;
  shaderError: string | null;
  voicePersona: VoicePersona;
  mcpLogs: McpToolCallRecord[];
  ttsBusy: boolean;
  onClose: () => void;
  onUpdatePhysics: (patch: Partial<PhysicsConfig>) => void;
  onApplyShaders: (forceCode: string, colorCode: string, label: string) => void;
  onRunMcpCode: (code: string) => Promise<void>;
  onChangeVoicePersona: (voice: VoicePersona) => void;
  onTestVoice: () => void;
  onResetAll: () => void;
}

const FORMATIONS: Array<{ id: FormationId; label: string }> = [
  { id: 'fluid', label: 'Curl Fluid' },
  { id: 'torus', label: 'Torus Knot' },
  { id: 'helix', label: 'DNA Helix' },
  { id: 'mandala', label: 'Mandala' },
  { id: 'lattice', label: 'Wave Lattice' },
  { id: 'custom', label: 'MCP Custom' },
];

const VOICE_PERSONAS: VoicePersona[] = ['Kore', 'Fenrir', 'Puck', 'Charon', 'Zephyr'];

const DEFAULT_MCP_SCRIPT = `// Execute via MCP run_data_processor to generate a 3D Strange Attractor
let x = 0.1, y = 0.0, z = 0.0;
const dt = 0.008, a = 10, b = 28, c = 8 / 3;
for (let i = 0; i < 2400; i++) {
  const dx = a * (y - x);
  const dy = x * (b - z) - y;
  const dz = x * y - c * z;
  x += dx * dt;
  y += dy * dt;
  z += dz * dt;
  emitPoint(x * 0.042, (z - 25) * 0.042, y * 0.042);
}`;

export function McpInspectorDrawer({
  open,
  initialTab = 'physics',
  physics,
  shaderConfig,
  shaderError,
  voicePersona,
  mcpLogs,
  ttsBusy,
  onClose,
  onUpdatePhysics,
  onApplyShaders,
  onRunMcpCode,
  onChangeVoicePersona,
  onTestVoice,
  onResetAll,
}: McpInspectorDrawerProps) {
  const [tab, setTab] = useState<'physics' | 'shaders' | 'mcp'>(initialTab);
  const [forceDraft, setForceDraft] = useState(shaderConfig.forceCode);
  const [colorDraft, setColorDraft] = useState(shaderConfig.colorCode);
  const [mcpScript, setMcpScript] = useState(DEFAULT_MCP_SCRIPT);
  const [runningScript, setRunningScript] = useState(false);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    setForceDraft(shaderConfig.forceCode);
    setColorDraft(shaderConfig.colorCode);
  }, [shaderConfig.forceCode, shaderConfig.colorCode]);

  if (!open) return null;

  const handleRunScript = async () => {
    if (!mcpScript.trim() || runningScript) return;
    setRunningScript(true);
    try {
      await onRunMcpCode(mcpScript);
    } finally {
      setRunningScript(false);
    }
  };

  return (
    <aside
      aria-label="MCP and Shader Inspector"
      className="fixed inset-y-14 right-0 z-30 flex w-full flex-col border-l border-[#1E293B] bg-[#0B0E17]/95 backdrop-blur-md sm:w-[400px]"
    >
      {/* Drawer Header & Segmented Tabs */}
      <div className="flex items-center justify-between border-b border-[#1E293B] px-4 py-3">
        <div className="flex items-center gap-1 rounded-lg bg-[#07090E] p-1 border border-[#1E293B]">
          {(
            [
              { id: 'physics', label: 'Physics' },
              { id: 'shaders', label: 'GLSL Shaders' },
              { id: 'mcp', label: 'MCP Code' },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                tab === item.id
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={onClose}
          title="Close inspector"
          className="flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="lab-scroll flex-1 overflow-y-auto p-4 space-y-6">
        {tab === 'physics' && (
          <>
            {/* Particle Density */}
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-200">Particle Density</h3>
                <span className="font-mono text-xs tabular-nums text-cyan-400">
                  {physics.particleCount.toLocaleString()} pts
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-[#1E293B] bg-[#07090E] p-1">
                {([16384, 32768, 65536] as const).map((count) => (
                  <button
                    key={count}
                    type="button"
                    onClick={() => onUpdatePhysics({ particleCount: count })}
                    className={`rounded-md py-1.5 font-mono text-xs tabular-nums transition-colors ${
                      physics.particleCount === count
                        ? 'bg-cyan-500/20 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {Math.round(count / 1024)}K
                  </button>
                ))}
              </div>
            </section>

            {/* Formation Morph Targets */}
            <section className="space-y-2">
              <h3 className="text-xs font-semibold text-slate-200">Shape Imitation Target</h3>
              <div className="grid grid-cols-2 gap-1.5">
                {FORMATIONS.map((f) => {
                  const active = physics.formation === f.id;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() =>
                        onUpdatePhysics({
                          formation: f.id,
                          morphStrength: f.id === 'fluid' ? 0 : Math.max(physics.morphStrength, 0.72),
                        })
                      }
                      className={`rounded-lg border px-3 py-2 text-left text-xs font-medium transition-colors ${
                        active
                          ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                          : 'border-[#1E293B] bg-[#07090E] text-slate-300 hover:border-slate-700'
                      }`}
                    >
                      {f.label}
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Synthesized Voice Persona */}
            <section className="space-y-2 border-t border-[#1E293B] pt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-200">Synthesized Voice Persona</h3>
                <button
                  type="button"
                  disabled={ttsBusy}
                  onClick={onTestVoice}
                  className="text-xs font-medium text-cyan-400 hover:text-cyan-300 disabled:opacity-50"
                >
                  {ttsBusy ? 'Synthesizing...' : 'Test Voice'}
                </button>
              </div>
              <div className="grid grid-cols-5 gap-1 rounded-lg border border-[#1E293B] bg-[#07090E] p-1">
                {VOICE_PERSONAS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => onChangeVoicePersona(v)}
                    className={`rounded-md py-1.5 text-[11px] font-medium transition-colors ${
                      voicePersona === v
                        ? 'bg-slate-800 text-cyan-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </section>

            {/* Fluid & Audio Sliders */}
            <section className="space-y-3.5 border-t border-[#1E293B] pt-4">
              <SliderControl
                label="Morph Stiffness"
                value={physics.morphStrength}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => onUpdatePhysics({ morphStrength: v })}
              />
              <SliderControl
                label="Curl Turbulence"
                value={physics.curlStrength}
                min={0}
                max={3.5}
                step={0.05}
                onChange={(v) => onUpdatePhysics({ curlStrength: v })}
              />
              <SliderControl
                label="Fluid Viscosity"
                value={physics.viscosity}
                min={0.8}
                max={0.99}
                step={0.005}
                onChange={(v) => onUpdatePhysics({ viscosity: v })}
              />
              <SliderControl
                label="Cursor Radius"
                value={physics.cursorRadius}
                min={0.15}
                max={1.5}
                step={0.05}
                onChange={(v) => onUpdatePhysics({ cursorRadius: v })}
              />
              <SliderControl
                label="Cursor Force"
                value={physics.cursorForce}
                min={0.2}
                max={6.0}
                step={0.1}
                onChange={(v) => onUpdatePhysics({ cursorForce: v })}
              />
              <SliderControl
                label="Chant Sensitivity"
                value={physics.audioSensitivity}
                min={0}
                max={3.5}
                step={0.05}
                onChange={(v) => onUpdatePhysics({ audioSensitivity: v })}
              />
              <SliderControl
                label="Particle Size"
                value={physics.pointSize}
                min={1.0}
                max={5.5}
                step={0.05}
                onChange={(v) => onUpdatePhysics({ pointSize: v })}
              />
            </section>

            {/* Spectrum Colors & Reset */}
            <section className="space-y-3 border-t border-[#1E293B] pt-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="flex items-center justify-between rounded-lg border border-[#1E293B] bg-[#07090E] px-3 py-2 text-xs text-slate-300">
                  <span>Primary</span>
                  <input
                    type="color"
                    value={physics.primaryColor}
                    onChange={(e) => onUpdatePhysics({ primaryColor: e.target.value })}
                    className="h-5 w-7 cursor-pointer bg-transparent"
                  />
                </label>
                <label className="flex items-center justify-between rounded-lg border border-[#1E293B] bg-[#07090E] px-3 py-2 text-xs text-slate-300">
                  <span>Accent</span>
                  <input
                    type="color"
                    value={physics.accentColor}
                    onChange={(e) => onUpdatePhysics({ accentColor: e.target.value })}
                    className="h-5 w-7 cursor-pointer bg-transparent"
                  />
                </label>
              </div>
              <button
                type="button"
                onClick={onResetAll}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-[#1E293B] bg-[#07090E] py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                <span>Reset Engine Defaults</span>
              </button>
            </section>
          </>
        )}

        {tab === 'shaders' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-semibold text-slate-200">{shaderConfig.label}</h3>
                <p className="text-[11px] text-slate-400">GLSL ES 3.00 Hot-Swap Pipeline</p>
              </div>
              {shaderError ? (
                <span className="flex items-center gap-1 text-xs font-medium text-rose-400">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  <span>Compile Error</span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-medium text-emerald-400">
                  <Check className="h-3.5 w-3.5" />
                  <span>Active</span>
                </span>
              )}
            </div>

            {shaderError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-950/30 p-2.5 font-mono text-[11px] text-rose-300 whitespace-pre-wrap">
                {shaderError}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block font-mono text-[11px] text-slate-400">
                customForce(pos, vel, time, audio, cursor, cursorDown, seed)
              </label>
              <textarea
                value={forceDraft}
                onChange={(e) => setForceDraft(e.target.value)}
                rows={10}
                spellCheck={false}
                className="w-full rounded-lg border border-[#1E293B] bg-[#07090E] p-2.5 font-mono text-[11px] leading-relaxed text-cyan-200 focus:border-cyan-500/60 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block font-mono text-[11px] text-slate-400">
                customColor(speed, energy, audio, pos, seed, primaryCol, accentCol)
              </label>
              <textarea
                value={colorDraft}
                onChange={(e) => setColorDraft(e.target.value)}
                rows={8}
                spellCheck={false}
                className="w-full rounded-lg border border-[#1E293B] bg-[#07090E] p-2.5 font-mono text-[11px] leading-relaxed text-amber-200 focus:border-cyan-500/60 focus:outline-none"
              />
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onApplyShaders(forceDraft, colorDraft, 'Manual GLSL Edit')}
                className="flex-1 rounded-lg bg-cyan-500 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400"
              >
                Compile & Hot-Swap
              </button>
              <button
                type="button"
                onClick={() => {
                  setForceDraft(DEFAULT_FORCE_CODE);
                  setColorDraft(DEFAULT_COLOR_CODE);
                  onApplyShaders(DEFAULT_FORCE_CODE, DEFAULT_COLOR_CODE, 'Default Harmonic Field');
                }}
                className="rounded-lg border border-[#1E293B] bg-[#07090E] px-3 py-2 text-xs font-medium text-slate-300 hover:border-slate-600"
              >
                Restore
              </button>
            </div>
          </div>
        )}

        {tab === 'mcp' && (
          <div className="space-y-5">
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-slate-200">
                  MCP Data Processor Sandbox
                </h3>
                <span className="font-mono text-[11px] text-slate-400">POST /api/mcp</span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-400">
                Run JavaScript via the MCP <code className="text-cyan-300">run_data_processor</code> tool
                to compute custom 3D particle attractors with <code className="text-cyan-300">emitPoint(x, y, z)</code>.
              </p>
              <textarea
                value={mcpScript}
                onChange={(e) => setMcpScript(e.target.value)}
                rows={10}
                spellCheck={false}
                className="w-full rounded-lg border border-[#1E293B] bg-[#07090E] p-2.5 font-mono text-[11px] leading-relaxed text-slate-200 focus:border-cyan-500/60 focus:outline-none"
              />
              <button
                type="button"
                disabled={runningScript}
                onClick={handleRunScript}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-cyan-500 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-cyan-400 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{runningScript ? 'Executing MCP Tool...' : 'Execute via MCP'}</span>
              </button>
            </section>

            <section className="space-y-2 border-t border-[#1E293B] pt-4">
              <div className="flex items-center justify-between">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold text-slate-200">
                  <Terminal className="h-3.5 w-3.5 text-cyan-400" />
                  <span>MCP Tool Execution Log</span>
                </h3>
                <span className="font-mono text-[11px] tabular-nums text-slate-500">
                  {mcpLogs.length} calls
                </span>
              </div>

              {mcpLogs.length === 0 ? (
                <p className="rounded-lg border border-[#1E293B] bg-[#07090E] p-3 text-xs text-slate-500">
                  No MCP tool calls yet. Submit a voice chant, preset directive, or execute the data processor above.
                </p>
              ) : (
                <div className="space-y-2">
                  {mcpLogs.map((log) => (
                    <div
                      key={log.id}
                      className="rounded-lg border border-[#1E293B] bg-[#07090E] p-2.5 space-y-1"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold text-cyan-300 truncate">
                          {log.toolName}
                        </span>
                        <span
                          className={`font-mono text-[11px] tabular-nums shrink-0 ${
                            log.status === 'ok' ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {log.status === 'ok' ? 'OK' : 'ERR'} · {log.durationMs.toFixed(1)}ms
                        </span>
                      </div>
                      <p className="text-[11px] leading-snug text-slate-300">
                        {log.resultSummary}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </aside>
  );
}

interface SliderControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function SliderControl({ label, value, min, max, step, onChange }: SliderControlProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-300">{label}</span>
        <span className="font-mono text-xs tabular-nums text-slate-400">
          {value.toFixed(step < 0.01 ? 3 : 2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="lab-slider w-full"
      />
    </div>
  );
}
