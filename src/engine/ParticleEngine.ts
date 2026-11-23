import { BEHAVIORS, hexToRgb, type VisualParams } from '../../shared/params';
import { buildShapeTargets } from './shapes';

export type PointerMode = 'attract' | 'repel' | 'swirl' | 'orbit';

export interface EngineStats {
  fps: number;
  count: number;
  targetCount: number;
}

export interface EngineOptions {
  maxParticles: number;
  initialCount: number;
  autoQuality: boolean;
  reducedMotion: boolean;
  onStats?: (s: EngineStats) => void;
  onContextChange?: (lost: boolean) => void;
}

const UPDATE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;   // xyz + seed
layout(location=1) in vec4 aVel;   // xyz + phase
layout(location=2) in vec3 aTarget;
out vec4 vPos;
out vec4 vVel;
uniform float uTime, uDt, uTurb, uShapeStrength, uForce, uRadius, uAspect, uFocal, uCamDist;
uniform int uBehavior;
uniform mat3 uRot;
uniform vec2 uPointer, uPointerVel;
uniform float uPointerDown, uPointerHover;
uniform int uMode;

vec3 flowField(vec3 p, float t) {
  // Cheap divergence-free field: each component ignores its own axis.
  return vec3(
    sin(p.y * 1.7 + t) + sin(p.z * 2.3 - t * 0.7),
    sin(p.z * 1.9 + t * 0.8) + sin(p.x * 2.1 + t * 0.5),
    sin(p.x * 1.5 - t * 0.6) + sin(p.y * 2.7 + t * 0.9)
  ) * 0.5;
}

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }

void main() {
  vec3 pos = aPos.xyz; float seed = aPos.w;
  vec3 vel = aVel.xyz; float phase = aVel.w;
  float t = uTime;
  vec3 target = aTarget;
  float spring = 4.0;
  float turb = uTurb;
  vec3 extra = vec3(0.0);

  if (uBehavior == 1) {            // swirl
    target = rotY(t * 0.9) * target;
    vec3 tang = vec3(-pos.z, 0.0, pos.x);
    extra += tang * 0.9 + vec3(0.0, 0.25 * sin(t + seed * 6.28), 0.0);
  } else if (uBehavior == 2) {     // storm
    turb = turb * 2.2 + 0.6;
    spring = 2.0;
    float jolt = step(0.985, fract(sin(floor(t * 3.0) * 12.9898 + seed * 78.233) * 43758.5453));
    extra += normalize(vec3(sin(seed * 91.0), cos(seed * 47.0), sin(seed * 13.0)) + 0.0001) * jolt * 14.0;
  } else if (uBehavior == 3) {     // pulse (heartbeat)
    float ph = fract(t * 1.1);
    float beat = exp(-pow(ph * 10.0 - 1.0, 2.0)) + 0.6 * exp(-pow(ph * 10.0 - 3.2, 2.0));
    target *= 1.0 + 0.16 * beat;
    spring = 7.0;
  } else if (uBehavior == 4) {     // explode
    float ph = fract(t * 0.2);
    float burst = exp(-pow((ph - 0.12) * 7.0, 2.0));
    vec3 dir = normalize(target + vec3(sin(seed * 31.0), cos(seed * 17.0), sin(seed * 7.0)) * 0.4 + 0.0001);
    target += dir * burst * (1.6 + fract(seed * 13.0) * 1.4);
    spring = 3.0 + (1.0 - burst) * 2.0;
  } else if (uBehavior == 5) {     // orbit
    target = rotY(t * 0.35) * target;
  } else if (uBehavior == 6) {     // flow
    target.y += sin(target.x * 2.5 + t * 1.6) * 0.18 + cos(target.z * 2.0 + t * 1.1) * 0.12;
    extra += vec3(0.25, 0.0, 0.1);
  } else if (uBehavior == 7) {     // calm
    turb *= 0.35;
    spring = 2.5;
  }

  vec3 acc = (target - pos) * spring * uShapeStrength;
  acc += flowField(pos * 1.3 + seed * 0.3, t * 0.6) * turb * 1.6;
  acc += extra;

  // Pointer interaction in screen space, applied in view space then rotated back to world.
  if (uPointerDown > 0.0 || uPointerHover > 0.0) {
    vec3 v = uRot * pos;
    float w = max(uCamDist - v.z, 0.2);
    vec2 ndc = v.xy * uFocal / w / vec2(uAspect, 1.0);
    vec2 d = (uPointer - ndc) * vec2(uAspect, 1.0) * w / uFocal;
    float dist = length(d);
    float infl = smoothstep(uRadius, 0.0, dist);
    if (infl > 0.0) {
      vec2 dir = d / (dist + 0.0001);
      vec3 f = vec3(0.0);
      if (uPointerDown > 0.0) {
        if (uMode == 0) f = vec3(dir, 0.0) * 9.0;
        else if (uMode == 1) f = vec3(-dir, 0.4 * sin(seed * 20.0)) * 11.0;
        else if (uMode == 2) f = vec3(-dir.y, dir.x, 0.0) * 10.0 + vec3(dir, 0.0) * 2.0;
      }
      f.xy += uPointerVel * 6.0 * (uPointerDown > 0.0 ? 1.0 : uPointerHover);
      acc += transpose(uRot) * f * infl * uForce;
    }
  }

  // Soft containment.
  float r = length(pos);
  acc -= pos * smoothstep(2.4, 4.0, r) * 4.0;

  vel += acc * uDt;
  vel *= exp(-uDt * 2.2);
  float sp = length(vel);
  if (sp > 6.0) vel *= 6.0 / sp;
  pos += vel * uDt;

  vPos = vec4(pos, seed);
  vVel = vec4(vel, phase);
  gl_Position = vec4(0.0);
}`;

const UPDATE_FS = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.0); }`;

const RENDER_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 aPos;
layout(location=1) in vec4 aVel;
uniform mat3 uRot;
uniform float uAspect, uFocal, uCamDist, uSize, uSizeBoost, uPixelRatio, uHeight;
uniform vec3 uPrimary, uAccent;
out vec3 vColor;
out float vAlpha;
void main() {
  vec3 v = uRot * aPos.xyz;
  float w = max(uCamDist - v.z, 0.15);
  gl_Position = vec4(v.x * uFocal / uAspect, v.y * uFocal, 0.0, w);
  float speed = length(aVel.xyz);
  float m = clamp(speed * 0.35 + fract(aPos.w * 7.13) * 0.45, 0.0, 1.0);
  vColor = mix(uPrimary, uAccent, m) * (0.75 + 0.5 * clamp(speed * 0.25, 0.0, 1.0));
  float px = uSize * uSizeBoost * uPixelRatio * (uHeight / 900.0) * 7.0 / w;
  gl_PointSize = clamp(px, 1.0, 48.0);
  vAlpha = clamp(0.6 * 4.2 / w, 0.2, 0.95);
}`;

const RENDER_FS = `#version 300 es
precision mediump float;
in vec3 vColor;
in float vAlpha;
out vec4 o;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float d = dot(c, c);
  if (d > 1.0) discard;
  float a = (1.0 - d) * (1.0 - d) * vAlpha;
  o = vec4(vColor * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return s;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string, varyings?: string[]): WebGLProgram {
  const p = gl.createProgram()!;
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
  return p;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]): Uniforms {
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return u;
}

interface Live {
  primary: [number, number, number];
  accent: [number, number, number];
  background: [number, number, number];
  speed: number;
  size: number;
  turbulence: number;
  shapeStrength: number;
  force: number;
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const PLANAR = new Set(['heart', 'star', 'flower']);

export class ParticleEngine {
  private readonly canvas: HTMLCanvasElement;
  private gl!: WebGL2RenderingContext;
  private opts: EngineOptions;
  private updateProg!: WebGLProgram;
  private renderProg!: WebGLProgram;
  private uu!: Uniforms;
  private ru!: Uniforms;
  private vaos: WebGLVertexArrayObject[] = [];
  private stateBufs: WebGLBuffer[] = [];
  private targetBuf!: WebGLBuffer;
  private tf!: WebGLTransformFeedback;
  private read = 0;
  private raf = 0;
  private running = false;
  private lost = false;
  private last = 0;
  private time = 0;

  private params: VisualParams;
  private live: Live;
  private targets: Float32Array<ArrayBuffer>;
  private behaviorIndex = 0;

  private userCount: number;
  private count: number;
  private autoQuality: boolean;

  // camera
  private yaw = 0.4;
  private pitch = 0.35;
  private swayT = 0;
  private camDist = 4.2;
  private targetCamDist = 4.2;
  private autoRotate = true;

  // pointer
  private mode: PointerMode = 'attract';
  private pointers = new Map<number, { x: number; y: number; type: string }>();
  private pointer = { x: 0, y: 0, vx: 0, vy: 0, down: false, hover: 0 };
  private pinchDist = 0;
  private lastPointerMove = 0;

  // stats
  private frameTimes: number[] = [];
  private statsAt = 0;
  private qualityAt = 0;
  private dpr = 1;
  private readonly rot: Float32Array<ArrayBuffer> = new Float32Array(9);
  private readonly cleanup: Array<() => void> = [];
  private ro?: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, params: VisualParams, opts: EngineOptions) {
    this.canvas = canvas;
    this.opts = opts;
    this.params = { ...params };
    this.live = this.toLive(params);
    this.userCount = Math.min(opts.initialCount, opts.maxParticles);
    this.count = this.userCount;
    this.autoQuality = opts.autoQuality;
    this.targets = buildShapeTargets(params.shape, opts.maxParticles);
    this.behaviorIndex = Math.max(0, BEHAVIORS.indexOf(params.behavior));
    this.autoRotate = !opts.reducedMotion;
    this.initGl();
    this.bindEvents();
  }

  private toLive(p: VisualParams): Live {
    return {
      primary: hexToRgb(p.primary),
      accent: hexToRgb(p.accent),
      background: hexToRgb(p.background),
      speed: p.speed,
      size: p.size,
      turbulence: p.turbulence,
      shapeStrength: p.shapeStrength,
      force: p.force,
    };
  }

  private initGl(): void {
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl;
    this.updateProg = link(gl, UPDATE_VS, UPDATE_FS, ['vPos', 'vVel']);
    this.renderProg = link(gl, RENDER_VS, RENDER_FS);
    this.uu = uniforms(gl, this.updateProg, [
      'uTime', 'uDt', 'uTurb', 'uShapeStrength', 'uForce', 'uRadius', 'uAspect', 'uFocal', 'uCamDist',
      'uBehavior', 'uRot', 'uPointer', 'uPointerVel', 'uPointerDown', 'uPointerHover', 'uMode',
    ]);
    this.ru = uniforms(gl, this.renderProg, [
      'uRot', 'uAspect', 'uFocal', 'uCamDist', 'uSize', 'uSizeBoost', 'uPixelRatio', 'uHeight', 'uPrimary', 'uAccent',
    ]);

    const n = this.opts.maxParticles;
    const init = new Float32Array(n * 8);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const r = Math.cbrt(Math.random()) * 2.2;
      const s = Math.sqrt(1 - u * u);
      init[i * 8] = s * Math.cos(th) * r;
      init[i * 8 + 1] = u * r;
      init[i * 8 + 2] = s * Math.sin(th) * r;
      init[i * 8 + 3] = Math.random();
      init[i * 8 + 7] = Math.random();
    }

    this.targetBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.targetBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.targets, gl.DYNAMIC_DRAW);

    this.stateBufs = [];
    this.vaos = [];
    for (let k = 0; k < 2; k++) {
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, init, gl.DYNAMIC_COPY);
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.targetBuf);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 12, 0);
      gl.bindVertexArray(null);
      this.stateBufs.push(buf);
      this.vaos.push(vao);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.tf = gl.createTransformFeedback()!;
    this.read = 0;
    this.resize();
  }

  private bindEvents(): void {
    const c = this.canvas;
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement | Window,
      ev: K | string,
      fn: (e: never) => void,
      o?: AddEventListenerOptions,
    ) => {
      el.addEventListener(ev, fn as EventListener, o);
      this.cleanup.push(() => el.removeEventListener(ev, fn as EventListener, o));
    };

    on(c, 'webglcontextlost', (e: Event) => {
      e.preventDefault();
      this.lost = true;
      cancelAnimationFrame(this.raf);
      this.opts.onContextChange?.(true);
    });
    on(c, 'webglcontextrestored', () => {
      this.lost = false;
      try {
        this.initGl();
        this.opts.onContextChange?.(false);
        if (this.running) this.loop();
      } catch {
        this.opts.onContextChange?.(true);
      }
    });

    on(c, 'pointerdown', (e: PointerEvent) => {
      c.setPointerCapture?.(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      if (this.pointers.size === 2) {
        this.pinchDist = this.currentPinch();
        this.pointer.down = false;
      } else {
        this.updatePointer(e.clientX, e.clientY, true);
        this.pointer.down = this.mode !== 'orbit';
      }
    });
    on(c, 'pointermove', (e: PointerEvent) => {
      const prev = this.pointers.get(e.pointerId);
      if (prev) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        prev.x = e.clientX;
        prev.y = e.clientY;
        if (this.pointers.size === 2) {
          const d = this.currentPinch();
          if (this.pinchDist > 0) this.zoomBy(this.pinchDist / Math.max(d, 1));
          this.pinchDist = d;
          return;
        }
        if (this.mode === 'orbit') {
          this.yaw += dx * 0.006;
          this.pitch = Math.max(-1.3, Math.min(1.3, this.pitch + dy * 0.006));
        }
      }
      this.updatePointer(e.clientX, e.clientY, false);
      if (e.pointerType === 'mouse') this.pointer.hover = 1;
    });
    const end = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinchDist = 0;
      if (this.pointers.size === 0) {
        this.pointer.down = false;
        if (e.pointerType !== 'mouse') this.pointer.hover = 0;
      }
    };
    on(c, 'pointerup', end);
    on(c, 'pointercancel', end);
    on(c, 'pointerleave', (e: PointerEvent) => {
      if (e.pointerType === 'mouse') this.pointer.hover = 0;
    });
    on(
      c,
      'wheel',
      (e: WheelEvent) => {
        e.preventDefault();
        this.zoomBy(Math.exp(e.deltaY * 0.0012));
      },
      { passive: false },
    );
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c);
    this.cleanup.push(() => this.ro?.disconnect());
  }

  private currentPinch(): number {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  private zoomBy(f: number): void {
    this.targetCamDist = Math.max(1.8, Math.min(9, this.targetCamDist * f));
  }

  private updatePointer(clientX: number, clientY: number, reset: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = ((clientX - rect.left) / Math.max(rect.width, 1)) * 2 - 1;
    const y = -(((clientY - rect.top) / Math.max(rect.height, 1)) * 2 - 1);
    const now = performance.now();
    const dt = Math.max((now - this.lastPointerMove) / 1000, 1 / 240);
    if (!reset) {
      this.pointer.vx = Math.max(-3, Math.min(3, (x - this.pointer.x) / dt / 10));
      this.pointer.vy = Math.max(-3, Math.min(3, (y - this.pointer.y) / dt / 10));
    } else {
      this.pointer.vx = 0;
      this.pointer.vy = 0;
    }
    this.pointer.x = x;
    this.pointer.y = y;
    this.lastPointerMove = now;
  }

  resize(): void {
    if (this.lost) return;
    const coarse = matchMedia('(pointer: coarse)').matches;
    this.dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * this.dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // ----- public API -----
  setParams(p: VisualParams): void {
    if (p.shape !== this.params.shape) {
      this.targets = buildShapeTargets(p.shape, this.opts.maxParticles, this.targets);
      if (!this.lost) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.targetBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.targets);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
    }
    this.behaviorIndex = Math.max(0, BEHAVIORS.indexOf(p.behavior));
    this.params = { ...p };
  }

  setCount(n: number): void {
    this.userCount = Math.max(1000, Math.min(this.opts.maxParticles, Math.round(n)));
    this.count = this.userCount;
  }

  setAutoQuality(on: boolean): void {
    this.autoQuality = on;
    if (!on) this.count = this.userCount;
  }

  setMode(m: PointerMode): void {
    this.mode = m;
  }

  /** Only scales motion; auto-rotate is controlled separately via setAutoRotate (user setting). */
  setReducedMotion(on: boolean): void {
    this.opts.reducedMotion = on;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
  }

  resetCamera(): void {
    this.yaw = 0.4;
    this.pitch = 0.35;
    this.targetCamDist = 4.2;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.loop();
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    for (const f of this.cleanup) f();
    this.cleanup.length = 0;
    const gl = this.gl;
    if (!gl || this.lost) return;
    for (const b of this.stateBufs) gl.deleteBuffer(b);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    gl.deleteBuffer(this.targetBuf);
    gl.deleteTransformFeedback(this.tf);
    gl.deleteProgram(this.updateProg);
    gl.deleteProgram(this.renderProg);
  }

  private loop = (): void => {
    if (!this.running || this.lost) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const rawDt = (now - this.last) / 1000;
    this.last = now;
    this.trackFrame(now, rawDt);
    this.frame(Math.min(rawDt, 1 / 30));
  };

  private trackFrame(now: number, dt: number): void {
    if (dt > 0 && dt < 1) this.frameTimes.push(dt);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    if (now - this.statsAt > 500) {
      this.statsAt = now;
      const fps = this.currentFps();
      this.opts.onStats?.({ fps, count: this.count, targetCount: this.userCount });
      (window as unknown as { __particleStats?: EngineStats }).__particleStats = { fps, count: this.count, targetCount: this.userCount };
    }
    if (this.autoQuality && now - this.qualityAt > 1200 && this.frameTimes.length >= 30) {
      this.qualityAt = now;
      const fps = this.currentFps();
      if (fps < 50 && this.count > 2000) {
        this.count = Math.max(2000, Math.round(this.count * (fps < 35 ? 0.6 : 0.8)));
        this.frameTimes.length = 0;
      } else if (fps > 58 && this.count < this.userCount) {
        this.count = Math.min(this.userCount, Math.round(this.count * 1.1));
      }
    }
  }

  private currentFps(): number {
    if (!this.frameTimes.length) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return Math.round(1 / median);
  }

  private frame(dt: number): void {
    const gl = this.gl;
    const p = this.params;
    const L = this.live;
    const k = 1 - Math.exp(-dt * 3);
    const tp = hexToRgb(p.primary);
    const ta = hexToRgb(p.accent);
    const tb = hexToRgb(p.background);
    for (let i = 0; i < 3; i++) {
      L.primary[i] = lerp(L.primary[i], tp[i], k);
      L.accent[i] = lerp(L.accent[i], ta[i], k);
      L.background[i] = lerp(L.background[i], tb[i], k);
    }
    L.speed = lerp(L.speed, p.speed, k);
    L.size = lerp(L.size, p.size, k);
    L.turbulence = lerp(L.turbulence, p.turbulence, k);
    L.shapeStrength = lerp(L.shapeStrength, p.shapeStrength, k);
    L.force = lerp(L.force, p.force, k);

    const motion = this.opts.reducedMotion ? 0.35 : 1;
    const simDt = dt * L.speed * motion;
    this.time += simDt;
    if (this.autoRotate && this.pointers.size === 0) {
      if (PLANAR.has(p.shape) && this.mode !== 'orbit') {
        this.swayT += dt * motion;
        const targetYaw = Math.sin(this.swayT * 0.35) * 0.45;
        const wrapped = Math.atan2(Math.sin(this.yaw), Math.cos(this.yaw));
        this.yaw = lerp(wrapped, targetYaw, 1 - Math.exp(-dt * 1.5));
      } else {
        this.yaw += dt * 0.08 * motion;
      }
    }
    this.camDist = lerp(this.camDist, this.targetCamDist, 1 - Math.exp(-dt * 8));
    // pointer velocity decays when not moving
    this.pointer.vx *= Math.exp(-dt * 6);
    this.pointer.vy *= Math.exp(-dt * 6);

    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    // R = Rx(pitch) * Ry(yaw), column-major
    const rot = this.rot;
    rot[0] = cy; rot[1] = sp * sy; rot[2] = -cp * sy;
    rot[3] = 0; rot[4] = cp; rot[5] = sp;
    rot[6] = sy; rot[7] = -sp * cy; rot[8] = cp * cy;
    const aspect = this.canvas.width / Math.max(this.canvas.height, 1);
    const focal = 1 / Math.tan((50 * Math.PI) / 360);
    // portrait screens: pull the camera back so shapes fit the narrow width
    const camDist = this.camDist * (aspect < 1 ? Math.min(2.2, 0.85 / Math.max(aspect, 0.2)) : 1);
    const count = this.count;
    const write = 1 - this.read;

    // simulate
    gl.useProgram(this.updateProg);
    const u = this.uu;
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uDt, Math.max(simDt, 0.0001));
    gl.uniform1f(u.uTurb, L.turbulence);
    gl.uniform1f(u.uShapeStrength, L.shapeStrength);
    gl.uniform1f(u.uForce, L.force);
    gl.uniform1f(u.uRadius, 0.55 + L.force * 0.12);
    gl.uniform1f(u.uAspect, aspect);
    gl.uniform1f(u.uFocal, focal);
    gl.uniform1f(u.uCamDist, camDist);
    gl.uniform1i(u.uBehavior, this.behaviorIndex);
    gl.uniformMatrix3fv(u.uRot, false, rot);
    gl.uniform2f(u.uPointer, this.pointer.x, this.pointer.y);
    gl.uniform2f(u.uPointerVel, this.pointer.vx, this.pointer.vy);
    gl.uniform1f(u.uPointerDown, this.pointer.down ? 1 : 0);
    gl.uniform1f(u.uPointerHover, this.pointer.hover * 0.5);
    gl.uniform1i(u.uMode, ['attract', 'repel', 'swirl', 'orbit'].indexOf(this.mode));

    gl.bindVertexArray(this.vaos[this.read]);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this.stateBufs[write]);
    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

    // render
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(L.background[0], L.background[1], L.background[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.renderProg);
    const r = this.ru;
    gl.uniformMatrix3fv(r.uRot, false, rot);
    gl.uniform1f(r.uAspect, aspect);
    gl.uniform1f(r.uFocal, focal);
    gl.uniform1f(r.uCamDist, camDist);
    gl.uniform1f(r.uSize, L.size);
    // fewer particles (auto quality / low count) -> slightly larger points to keep the image full
    gl.uniform1f(r.uSizeBoost, Math.min(1.8, Math.max(1, Math.sqrt(40_000 / Math.max(count, 1)))));
    gl.uniform1f(r.uPixelRatio, this.dpr);
    gl.uniform1f(r.uHeight, this.canvas.clientHeight || 900);
    gl.uniform3f(r.uPrimary, L.primary[0], L.primary[1], L.primary[2]);
    gl.uniform3f(r.uAccent, L.accent[0], L.accent[1], L.accent[2]);
    gl.bindVertexArray(this.vaos[write]);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    this.read = write;
  }
}
