import type { Shape } from '../../shared/params';

/** Deterministic PRNG so every prefix of the target buffer covers the whole shape. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

type Gen = (r: () => number, i: number, out: Float32Array, o: number) => void;

const TAU = Math.PI * 2;

const generators: Record<Shape, Gen> = {
  nebula(r, i, out, o) {
    const lobes = [
      [0, 0, 0, 0.75],
      [0.7, 0.3, -0.2, 0.45],
      [-0.6, -0.35, 0.25, 0.5],
    ];
    const l = lobes[i % 3];
    out[o] = l[0] + gauss(r) * l[3] * 0.6;
    out[o + 1] = l[1] + gauss(r) * l[3] * 0.45;
    out[o + 2] = l[2] + gauss(r) * l[3] * 0.6;
  },
  sphere(r, _i, out, o) {
    const u = r() * 2 - 1;
    const th = r() * TAU;
    const rad = 1.15 + gauss(r) * 0.03;
    const s = Math.sqrt(1 - u * u);
    out[o] = s * Math.cos(th) * rad;
    out[o + 1] = u * rad;
    out[o + 2] = s * Math.sin(th) * rad;
  },
  galaxy(r, i, out, o) {
    if (i % 7 === 0) {
      out[o] = gauss(r) * 0.18;
      out[o + 1] = gauss(r) * 0.1;
      out[o + 2] = gauss(r) * 0.18;
      return;
    }
    const arms = 3;
    const rad = 0.15 + Math.pow(r(), 0.7) * 1.55;
    const arm = i % arms;
    const ang = (arm / arms) * TAU + rad * 2.6 + gauss(r) * 0.22 * (0.4 + rad * 0.4);
    out[o] = Math.cos(ang) * rad;
    out[o + 1] = gauss(r) * 0.05 * (1.8 - rad);
    out[o + 2] = Math.sin(ang) * rad;
  },
  heart(r, _i, out, o) {
    const t = r() * TAU;
    const fill = Math.sqrt(r());
    const x = 16 * Math.pow(Math.sin(t), 3);
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    const k = 0.075 * (0.15 + 0.85 * fill);
    out[o] = x * k;
    out[o + 1] = y * k + 0.15;
    out[o + 2] = gauss(r) * 0.18 * (1 - fill * 0.6);
  },
  torus(r, _i, out, o) {
    const a = r() * TAU;
    const b = r() * TAU;
    const R = 1.0;
    const rr = 0.36 + gauss(r) * 0.02;
    out[o] = (R + rr * Math.cos(b)) * Math.cos(a);
    out[o + 1] = rr * Math.sin(b);
    out[o + 2] = (R + rr * Math.cos(b)) * Math.sin(a);
  },
  helix(r, i, out, o) {
    const y = r() * 2.8 - 1.4;
    if (i % 9 === 0) {
      // rungs
      const ang = Math.round(y * 6) / 6 * 4;
      const s = r() * 2 - 1;
      out[o] = Math.cos(ang) * 0.5 * s;
      out[o + 1] = Math.round(y * 6) / 6;
      out[o + 2] = Math.sin(ang) * 0.5 * s;
      return;
    }
    const strand = i % 2;
    const ang = y * 4 + strand * Math.PI;
    out[o] = Math.cos(ang) * 0.5 + gauss(r) * 0.03;
    out[o + 1] = y;
    out[o + 2] = Math.sin(ang) * 0.5 + gauss(r) * 0.03;
  },
  ring(r, _i, out, o) {
    const a = r() * TAU;
    const rad = 1.25 + gauss(r) * 0.05;
    out[o] = Math.cos(a) * rad;
    out[o + 1] = gauss(r) * 0.03;
    out[o + 2] = Math.sin(a) * rad;
  },
  cube(r, _i, out, o) {
    const face = Math.floor(r() * 6);
    const s = 0.85;
    const u = (r() * 2 - 1) * s;
    const v = (r() * 2 - 1) * s;
    const w = face % 2 === 0 ? s : -s;
    const axis = Math.floor(face / 2);
    const p = axis === 0 ? [w, u, v] : axis === 1 ? [u, w, v] : [u, v, w];
    out[o] = p[0];
    out[o + 1] = p[1];
    out[o + 2] = p[2];
  },
  wave(r, _i, out, o) {
    const x = r() * 3.6 - 1.8;
    const z = r() * 3.6 - 1.8;
    out[o] = x;
    out[o + 1] = 0.22 * Math.sin(x * 2.2) * Math.cos(z * 1.7) - 0.2;
    out[o + 2] = z;
  },
  star(r, _i, out, o) {
    const points = 5;
    const t = r() * TAU;
    const seg = (t / TAU) * points * 2;
    const k = seg - Math.floor(seg);
    const outer = 1.3;
    const inner = 0.52;
    const a0 = Math.floor(seg) % 2 === 0 ? outer : inner;
    const a1 = Math.floor(seg) % 2 === 0 ? inner : outer;
    const th0 = (Math.floor(seg) / (points * 2)) * TAU;
    const th1 = ((Math.floor(seg) + 1) / (points * 2)) * TAU;
    const x0 = Math.sin(th0) * a0;
    const y0 = Math.cos(th0) * a0;
    const x1 = Math.sin(th1) * a1;
    const y1 = Math.cos(th1) * a1;
    const fill = Math.sqrt(r());
    out[o] = (x0 + (x1 - x0) * k) * fill;
    out[o + 1] = (y0 + (y1 - y0) * k) * fill;
    out[o + 2] = gauss(r) * 0.12 * (1 - fill * 0.7);
  },
  flower(r, _i, out, o) {
    const th = r() * TAU;
    const petals = 6;
    const rad = Math.abs(Math.cos((petals / 2) * th)) * 1.25 * Math.sqrt(r());
    out[o] = Math.cos(th) * rad;
    out[o + 1] = Math.sin(th) * rad;
    out[o + 2] = rad * rad * 0.35 - 0.2 + gauss(r) * 0.04;
  },
  tornado(r, _i, out, o) {
    const y = r() * 2.8 - 1.4;
    const rad = (0.08 + (y + 1.4) * 0.38) * (0.85 + r() * 0.3);
    const a = r() * TAU;
    out[o] = Math.cos(a) * rad;
    out[o + 1] = y;
    out[o + 2] = Math.sin(a) * rad;
  },
};

export function buildShapeTargets(
  shape: Shape,
  count: number,
  out: Float32Array<ArrayBuffer> = new Float32Array(count * 3),
): Float32Array<ArrayBuffer> {
  const gen = generators[shape] ?? generators.nebula;
  const r = mulberry32(0x9e3779b9 ^ shape.length * 7919);
  for (let i = 0; i < count; i++) gen(r, i, out, i * 3);
  return out;
}
