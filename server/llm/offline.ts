/**
 * Offline (no-LLM) prompt parser. Used when the local Ollama is disabled,
 * unreachable, times out or returns unusable output. Pure, deterministic.
 */
import {
  DEFAULT_PARAMS,
  NAMED_COLORS,
  NEON_COLORS,
  clamp,
  type Behavior,
  type Shape,
  type VisualParams,
  type VisualResult,
} from '../../shared/params.ts';

const SHAPE_WORDS: Array<[RegExp, Shape]> = [
  [/\b(heart|love|valentine)s?\b/, 'heart'],
  [/\b(galaxy|galaxies|spiral|milky ?way|cosmos)\b/, 'galaxy'],
  [/\b(tornado|twister|cyclone|hurricane|whirlwind)s?\b/, 'tornado'],
  [/\b(helix|dna|spring|coil)\b/, 'helix'],
  [/\b(torus|donut|doughnut)s?\b/, 'torus'],
  [/\b(ring|halo|circle|portal)s?\b/, 'ring'],
  [/\b(cube|box|block|grid|lattice)s?\b/, 'cube'],
  [/\b(wave|waves|ocean|sea|water|ripple)s?\b/, 'wave'],
  [/\b(star|starburst|firework|fireworks)s?\b/, 'star'],
  [/\b(flower|bloom|rose|petal|lotus|mandala)s?\b/, 'flower'],
  [/\b(sphere|ball|planet|orb|globe|moon|sun)s?\b/, 'sphere'],
  [/\b(nebula|cloud|smoke|fog|mist|dust|storm)s?\b/, 'nebula'],
];

const BEHAVIOR_WORDS: Array<[RegExp, Behavior]> = [
  [/\b(storm|chaos|chaotic|thunder|lightning|electric|wild|turbulent)\b/, 'storm'],
  [/\b(explod\w*|burst\w*|firework\w*|bang|supernova|shatter\w*)\b/, 'explode'],
  [/\b(pulse|pulsing|beat|beating|heartbeat|throb\w*|breath\w*)\b/, 'pulse'],
  [/\b(orbit\w*|revolv\w*|planet\w*|galaxy|spiral)\b/, 'orbit'],
  [/\b(swirl\w*|spin\w*|twist\w*|vortex|tornado|whirl\w*)\b/, 'swirl'],
  [/\b(flow\w*|river|ocean|wind|stream\w*|wave\w*)\b/, 'flow'],
  [/\b(calm|gentle|zen|peace\w*|sleep\w*|relax\w*|quiet|slow)\b/, 'calm'],
];

const THEMES: Array<[RegExp, [string, string]]> = [
  [/\b(fire|flame|lava|inferno|burning)\b/, ['#ff5f1f', '#facc15']],
  [/\b(ice|frost|frozen|snow|winter)\b/, ['#a5f3fc', '#f8fafc']],
  [/\b(forest|jungle|nature|leaf|leaves)\b/, ['#22c55e', '#a3e635']],
  [/\b(sunset|dusk)\b/, ['#f97316', '#ec4899']],
  [/\b(ocean|sea|water)\b/, ['#14b8a6', '#3b82f6']],
  [/\b(aurora|northern lights)\b/, ['#39ff14', '#8b5cf6']],
  [/\b(electric|lightning)\b/, ['#60a5fa', '#f8fafc']],
  [/\b(gold|golden|treasure)\b/, ['#fbbf24', '#f97316']],
  [/\b(love|valentine)\b/, ['#ff073a', '#f472b6']],
  [/\b(cyberpunk|synthwave|vaporwave)\b/, ['#ff2fd0', '#00fff7']],
];

function findColors(text: string): string[] {
  const found: Array<{ at: number; hex: string }> = [];
  const re = /\b(neon[\s-]?)?([a-z]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const word = m[2];
    const hex = m[1] ? NEON_COLORS[word] ?? NAMED_COLORS[word] : NAMED_COLORS[word];
    if (hex) found.push({ at: m.index, hex });
  }
  const hexes = text.match(/#[0-9a-f]{6}\b/g) ?? [];
  const seen = new Set<string>();
  return [...found.map((f) => f.hex), ...hexes].filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
}

function shift(hex: string): string {
  // Simple complementary-ish accent: rotate channels.
  return `#${hex.slice(5, 7)}${hex.slice(1, 3)}${hex.slice(3, 5)}`;
}

const SHAPE_DEFAULT_BEHAVIOR: Record<Shape, Behavior> = {
  nebula: 'drift',
  sphere: 'orbit',
  galaxy: 'orbit',
  heart: 'pulse',
  torus: 'swirl',
  helix: 'orbit',
  ring: 'orbit',
  cube: 'calm',
  wave: 'flow',
  star: 'pulse',
  flower: 'pulse',
  tornado: 'swirl',
};

export function parsePromptOffline(prompt: string): VisualResult {
  const text = prompt.toLowerCase();
  const p: VisualParams = { ...DEFAULT_PARAMS };

  const shapeHit = SHAPE_WORDS.find(([re]) => re.test(text));
  if (shapeHit) p.shape = shapeHit[1];
  const behaviorHit = BEHAVIOR_WORDS.find(([re]) => re.test(text));
  p.behavior = behaviorHit ? behaviorHit[1] : SHAPE_DEFAULT_BEHAVIOR[p.shape];

  const theme = THEMES.find(([re]) => re.test(text));
  const colors = findColors(text);
  if (colors.length > 0) {
    p.primary = colors[0];
    p.accent = colors[1] ?? (theme ? theme[1][1] : shift(colors[0]));
  } else if (theme) {
    [p.primary, p.accent] = theme[1];
  } else if (/\bneon\b/.test(text)) {
    p.primary = '#ff2fd0';
    p.accent = '#00fff7';
  }

  if (p.behavior === 'storm') {
    p.turbulence = 1.5;
    p.speed = 1.7;
    p.shapeStrength = 0.35;
    p.force = 2.4;
  } else if (p.behavior === 'calm') {
    p.turbulence = 0.2;
    p.speed = 0.5;
  } else if (p.behavior === 'explode') {
    p.speed = 1.4;
  }
  if (p.shape !== 'nebula' && p.behavior !== 'storm') p.shapeStrength = 0.85;

  if (/\b(fast|quick|hyper|rapid|crazy|frantic)\b/.test(text)) p.speed = clamp(p.speed * 1.8, 0.1, 3);
  if (/\b(slow|lazy|sleepy)\b/.test(text)) p.speed = clamp(p.speed * 0.5, 0.1, 3);
  if (/\b(big|large|huge|giant|bold)\b/.test(text)) p.size = 2.4;
  if (/\b(tiny|small|fine|dust|sparkle\w*)\b/.test(text)) p.size = 1.0;

  const words = prompt.trim().split(/\s+/).slice(0, 4).join(' ');
  p.label = words ? words.slice(0, 40) : p.label;
  p.speed = Math.round(p.speed * 1000) / 1000;

  return {
    params: p,
    reply: `Offline parser: ${p.shape} shape with ${p.behavior} motion.`,
    source: 'offline',
  };
}
