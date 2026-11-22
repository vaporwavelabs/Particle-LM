import { StudioMode } from '../types/simulation';

interface TopBarProps {
  activeMode: StudioMode;
  inspectorOpen: boolean;
  onSelectMode: (mode: StudioMode) => void;
  onToggleInspector: () => void;
}

const NAV_ITEMS: Array<{ id: StudioMode; label: string }> = [
  { id: 'fluid', label: 'Fluid' },
  { id: 'morph', label: 'Morph' },
  { id: 'chant', label: 'Chant' },
  { id: 'shader', label: 'Shader Lab' },
];

export function TopBar({
  activeMode,
  inspectorOpen,
  onSelectMode,
  onToggleInspector,
}: TopBarProps) {
  return (
    <header className="relative z-20 flex h-14 w-full items-center justify-between gap-8 border-b border-[#1E293B] bg-[#07090E]/90 px-6 backdrop-blur-md">
      {/* Zone 1: Single-line Brand Wordmark */}
      <a
        href="#top"
        onClick={(e) => {
          e.preventDefault();
          onSelectMode('fluid');
        }}
        className="whitespace-nowrap shrink-0 text-base font-semibold tracking-tight text-slate-100 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400"
      >
        Kinetix Chant
      </a>

      {/* Zone 2: 4 concise single-line nav links */}
      <nav className="hidden md:flex items-center gap-6" aria-label="Simulation modes">
        {NAV_ITEMS.map((item) => {
          const isActive = activeMode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectMode(item.id)}
              className={`whitespace-nowrap shrink-0 border-b-2 py-1 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cyan-400 ${
                isActive
                  ? 'border-cyan-400 text-slate-100'
                  : 'border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Zone 3: 1 Primary Action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onToggleInspector}
          className="min-h-[40px] whitespace-nowrap shrink-0 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-xs font-semibold text-cyan-300 transition-colors duration-150 hover:bg-cyan-500/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400"
        >
          {inspectorOpen ? 'Close Inspector' : 'Inspect MCP'}
        </button>
      </div>
    </header>
  );
}
