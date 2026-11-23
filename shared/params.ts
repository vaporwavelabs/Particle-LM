/**
 * Particle parameter contract shared by the server (LLM output validation)
 * and the browser (renderer). Everything the LLM returns is passed through
 * `sanitizeParams` before it can reach the GPU or the DOM.
 */

export const SHAPES = [
  'nebula',
  'sphere',
  'galaxy',
  'heart',
  'torus',
  'helix',
  'ring',
  'cube',
  'wave',
  'star',
  'flower',
  'tornado',
] as const;
export type Shape = (typeof SHAPES)[number];

export const BEHAVIORS = ['drift', 'swirl', 'storm', 'pulse', 'explode', 'orbit', 'flow', 'calm'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export interface VisualParams {
  label: string;
  shape: Shape;
  behavior: Behavior;
  primary: string;
  accent: string;
  background: string;
  speed: number;
  size: number;
  turbulence: number;
  shapeStrength: number;
  force: number;
}

export type ResultSource = 'llm' | 'offline';

export interface VisualResult {
  params: VisualParams;
  reply: string;
  source: ResultSource;
  notice?: string;
  issues?: string[];
}

export const LIMITS = {
  speed: [0.1, 3],
  size: [0.5, 4],
  turbulence: [0, 2],
  shapeStrength: [0, 1],
  force: [0.2, 4],
} as const satisfies Record<string, readonly [number, number]>;

export const MAX_REPLY_CHARS = 280;
export const MAX_LABEL_CHARS = 40;
export const MAX_PROMPT_CHARS = 4000;
export const LLM_PROMPT_CHARS = 1200;

export const DEFAULT_PARAMS: VisualParams = {
  label: 'Nebula drift',
  shape: 'nebula',
  behavior: 'drift',
  primary: '#22d3ee',
  accent: '#f472b6',
  background: '#05060b',
  speed: 1,
  size: 1.6,
  turbulence: 0.6,
  shapeStrength: 0.7,
  force: 1.5,
};

export const NAMED_COLORS: Record<string, string> = {
  red: '#ef4444',
  crimson: '#dc143c',
  scarlet: '#ff2400',
  orange: '#f97316',
  amber: '#f59e0b',
  gold: '#fbbf24',
  golden: '#fbbf24',
  yellow: '#facc15',
  lime: '#a3e635',
  green: '#22c55e',
  emerald: '#10b981',
  teal: '#14b8a6',
  cyan: '#22d3ee',
  aqua: '#00ffff',
  turquoise: '#40e0d0',
  blue: '#3b82f6',
  navy: '#1e3a8a',
  indigo: '#6366f1',
  violet: '#8b5cf6',
  purple: '#a855f7',
  magenta: '#ff00ff',
  fuchsia: '#d946ef',
  pink: '#ec4899',
  rose: '#f43f5e',
  white: '#f8fafc',
  silver: '#cbd5e1',
  grey: '#94a3b8',
  gray: '#94a3b8',
  black: '#0b0b0f',
  brown: '#92400e',
};

export const NEON_COLORS: Record<string, string> = {
  pink: '#ff2fd0',
  green: '#39ff14',
  blue: '#1f51ff',
  purple: '#bc13fe',
  orange: '#ff5f1f',
  yellow: '#ffff33',
  red: '#ff073a',
  cyan: '#00fff7',
};

const HEX6 = /^#[0-9a-f]{6}$/i;
const HEX3 = /^#[0-9a-f]{3}$/i;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** Normalises '#abc', '#AABBCC' or a colour name to lowercase '#rrggbb'. */
export function normalizeColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (HEX6.test(s)) return s;
  if (HEX3.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  const neon = s.match(/^neon[\s-]?([a-z]+)$/);
  if (neon && NEON_COLORS[neon[1]]) return NEON_COLORS[neon[1]];
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  return undefined;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeColor(hex) ?? '#ffffff';
  return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const c = (x: number) => Math.round(clamp(x, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Keeps the background dark enough for the UI and additive particles to stay readable. */
export function darkenBackground(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const maxLum = 0.12;
  if (lum <= maxLum) return rgbToHex([r, g, b]);
  const k = maxLum / lum;
  return rgbToHex([r * k, g * k, b * k]);
}

/** Strips control characters and collapses whitespace; output is only ever rendered as plain text. */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function pickEnum<T extends string>(v: unknown, allowed: readonly T[]): T | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : undefined;
}

export interface SanitizeOutput {
  params: VisualParams;
  reply: string;
  issues: string[];
}

/**
 * Validates and clamps untrusted (LLM) output. Unknown keys are dropped,
 * missing or invalid values fall back to `base`, numbers are clamped.
 */
export function sanitizeParams(raw: unknown, base: VisualParams = DEFAULT_PARAMS): SanitizeOutput {
  const issues: string[] = [];
  const src: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (src !== raw) issues.push('not an object');

  const out: VisualParams = { ...base };

  const shape = pickEnum(src.shape, SHAPES);
  if (shape) out.shape = shape;
  else if (src.shape !== undefined) issues.push('shape');

  const behavior = pickEnum(src.behavior, BEHAVIORS);
  if (behavior) out.behavior = behavior;
  else if (src.behavior !== undefined) issues.push('behavior');

  for (const key of ['primary', 'accent', 'background'] as const) {
    const c = normalizeColor(src[key]);
    if (c) out[key] = c;
    else if (src[key] !== undefined) issues.push(key);
  }
  out.background = darkenBackground(out.background);

  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const n = toNumber(src[key]);
    if (n === undefined) {
      if (src[key] !== undefined) issues.push(key);
      continue;
    }
    const [min, max] = LIMITS[key];
    const c = clamp(n, min, max);
    if (c !== n) issues.push(`${key} clamped`);
    out[key] = Math.round(c * 1000) / 1000;
  }

  const label = cleanText(src.label, MAX_LABEL_CHARS);
  if (label) out.label = label;
  const reply = cleanText(src.reply, MAX_REPLY_CHARS);
  return { params: out, reply, issues };
}

/** JSON schema handed to Ollama's structured-output `format` field. */
export const PARAMS_JSON_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'One short friendly sentence describing the scene.' },
    label: { type: 'string', description: '2-4 word title.' },
    shape: { type: 'string', enum: [...SHAPES] },
    behavior: { type: 'string', enum: [...BEHAVIORS] },
    primary: { type: 'string', description: 'hex colour #rrggbb' },
    accent: { type: 'string', description: 'hex colour #rrggbb' },
    background: { type: 'string', description: 'very dark hex colour #rrggbb' },
    speed: { type: 'number', minimum: LIMITS.speed[0], maximum: LIMITS.speed[1] },
    size: { type: 'number', minimum: LIMITS.size[0], maximum: LIMITS.size[1] },
    turbulence: { type: 'number', minimum: LIMITS.turbulence[0], maximum: LIMITS.turbulence[1] },
    shapeStrength: { type: 'number', minimum: LIMITS.shapeStrength[0], maximum: LIMITS.shapeStrength[1] },
    force: { type: 'number', minimum: LIMITS.force[0], maximum: LIMITS.force[1] },
  },
  required: [
    'reply',
    'label',
    'shape',
    'behavior',
    'primary',
    'accent',
    'background',
    'speed',
    'size',
    'turbulence',
    'shapeStrength',
    'force',
  ],
} as const;

export const PRESETS: Array<{ id: string; name: string; prompt: string; params: VisualParams }> = [
  { id: 'nebula', name: 'Nebula', prompt: 'soft cyan nebula drifting', params: DEFAULT_PARAMS },
  {
    id: 'galaxy',
    name: 'Galaxy',
    prompt: 'galaxy spiral in neon pink',
    params: { ...DEFAULT_PARAMS, label: 'Neon galaxy', shape: 'galaxy', behavior: 'orbit', primary: '#ff2fd0', accent: '#8b5cf6', background: '#07030c', speed: 1.1, size: 1.4, turbulence: 0.25, shapeStrength: 0.85 },
  },
  {
    id: 'heart',
    name: 'Heart',
    prompt: 'beating red heart',
    params: { ...DEFAULT_PARAMS, label: 'Beating heart', shape: 'heart', behavior: 'pulse', primary: '#ff073a', accent: '#f472b6', background: '#0c0306', speed: 1, size: 1.7, turbulence: 0.2, shapeStrength: 0.9 },
  },
  {
    id: 'storm',
    name: 'Storm',
    prompt: 'electric storm',
    params: { ...DEFAULT_PARAMS, label: 'Electric storm', shape: 'nebula', behavior: 'storm', primary: '#60a5fa', accent: '#f8fafc', background: '#03050b', speed: 1.8, size: 1.3, turbulence: 1.6, shapeStrength: 0.3, force: 2.4 },
  },
  {
    id: 'tornado',
    name: 'Tornado',
    prompt: 'golden tornado',
    params: { ...DEFAULT_PARAMS, label: 'Golden twister', shape: 'tornado', behavior: 'swirl', primary: '#fbbf24', accent: '#f97316', background: '#0a0603', speed: 1.5, size: 1.4, turbulence: 0.5, shapeStrength: 0.8 },
  },
  {
    id: 'dna',
    name: 'DNA',
    prompt: 'green dna helix',
    params: { ...DEFAULT_PARAMS, label: 'Helix', shape: 'helix', behavior: 'orbit', primary: '#39ff14', accent: '#22d3ee', background: '#020a05', speed: 0.9, size: 1.5, turbulence: 0.15, shapeStrength: 0.95 },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    prompt: 'calm ocean waves',
    params: { ...DEFAULT_PARAMS, label: 'Ocean waves', shape: 'wave', behavior: 'flow', primary: '#14b8a6', accent: '#3b82f6', background: '#020610', speed: 0.8, size: 1.5, turbulence: 0.3, shapeStrength: 0.85 },
  },
  {
    id: 'firework',
    name: 'Firework',
    prompt: 'exploding orange firework star',
    params: { ...DEFAULT_PARAMS, label: 'Firework', shape: 'star', behavior: 'explode', primary: '#ff5f1f', accent: '#facc15', background: '#060304', speed: 1.4, size: 1.6, turbulence: 0.4, shapeStrength: 0.7, force: 2 },
  },
];
