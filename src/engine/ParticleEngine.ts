import {
  AudioMetrics,
  DEFAULT_COLOR_CODE,
  DEFAULT_FORCE_CODE,
  FormationId,
  PhysicsConfig,
} from '../types/simulation';
import { buildFormationTargets } from './formations';

const MAX_PARTICLES = 65536;

function hexToRgbTuple(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return [0.024, 0.714, 0.831];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

function buildUpdateVertexShader(customForceGlsl: string): string {
  return `#version 300 es
precision highp float;

layout(location = 0) in vec4 aPosEnergy;
layout(location = 1) in vec4 aVelSeed;
layout(location = 2) in vec3 aTarget;

out vec4 vPosEnergy;
out vec4 vVelSeed;

uniform float uTime;
uniform float uDt;
uniform float uAspect;
uniform vec2 uCursor;
uniform vec2 uCursorVel;
uniform float uCursorDown;
uniform vec4 uAudio;
uniform float uCurlStrength;
uniform float uViscosity;
uniform float uCursorRadius;
uniform float uCursorForce;
uniform float uMorphStrength;
uniform float uAudioSensitivity;

// 3D Simplex Noise for divergence-free curl fluid advection
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

vec3 curlNoise(vec3 p) {
  float e = 0.08;
  float n1 = snoise(vec3(p.x, p.y + e, p.z));
  float n2 = snoise(vec3(p.x, p.y - e, p.z));
  float n3 = snoise(vec3(p.x, p.y, p.z + e));
  float n4 = snoise(vec3(p.x, p.y, p.z - e));
  float n5 = snoise(vec3(p.x + e, p.y, p.z));
  float n6 = snoise(vec3(p.x - e, p.y, p.z));
  float x = (n1 - n2) - (n3 - n4);
  float y = (n3 - n4) - (n5 - n6);
  float z = (n5 - n6) - (n1 - n2);
  return normalize(vec3(x, y, z) + vec3(0.0001));
}

${customForceGlsl}

void main() {
  vec3 pos = aPosEnergy.xyz;
  float energy = aPosEnergy.w;
  vec3 vel = aVelSeed.xyz;
  float seed = aVelSeed.w;

  vec4 scaledAudio = uAudio * uAudioSensitivity;

  // Curl-noise fluid field modulated by voice cadence
  float freq = 0.85 + scaledAudio.y * 0.45;
  vec3 curl = curlNoise(pos * freq + vec3(uTime * 0.14, -uTime * 0.09, uTime * 0.11));
  vec3 fluidAccel = curl * (uCurlStrength + scaledAudio.x * 1.45);

  // Cursor interaction in view-plane space
  vec2 cursorWorld = vec2(uCursor.x * uAspect * 1.45, uCursor.y * 1.45);
  vec2 toCursor = cursorWorld - pos.xy;
  float dist = length(toCursor);
  float influence = smoothstep(uCursorRadius, 0.0, dist);

  vec3 cursorAccel = vec3(0.0);
  if (influence > 0.001) {
    vec2 dir = toCursor / (dist + 0.0001);
    vec2 swirl = vec2(-dir.y, dir.x);
    // Wake from cursor movement + vortex swirl + click attract/repel
    cursorAccel.xy += uCursorVel * influence * uCursorForce * 16.0;
    cursorAccel.xy += swirl * influence * uCursorForce * 1.4;
    if (abs(uCursorDown) > 0.1) {
      cursorAccel.xy += dir * uCursorDown * influence * uCursorForce * 3.4;
      cursorAccel.z += uCursorDown * influence * 0.9;
    } else {
      cursorAccel.z += influence * sin(uTime * 6.0 + dist * 10.0) * 0.45;
    }
  }

  // Morphing attraction toward target shape (mitigated during high cursor wake)
  vec3 morphAccel = (aTarget - pos) * uMorphStrength * 5.2;

  // Center containment spring so fluid particles never drift off-screen permanently
  float boundR = length(pos);
  vec3 containAccel = -pos * smoothstep(1.35, 2.5, boundR) * 1.65;

  // AI/MCP Hot-Swappable Custom Force
  vec3 mcpAccel = customForce(pos, vel, uTime, scaledAudio, uCursor, uCursorDown, seed);

  vel += (fluidAccel + cursorAccel + morphAccel + containAccel + mcpAccel) * uDt;
  vel *= pow(uViscosity, uDt * 60.0);

  // Clamp extreme velocities for numerical stability
  float speed = length(vel);
  if (speed > 4.5) {
    vel = (vel / speed) * 4.5;
  }

  pos += vel * uDt;

  float nextEnergy = clamp(mix(energy, speed * 0.55 + influence * 0.65 + scaledAudio.w * 0.6, 0.12), 0.0, 1.0);

  vPosEnergy = vec4(pos, nextEnergy);
  vVelSeed = vec4(vel, seed);
  gl_Position = vec4(0.0);
}`;
}

const UPDATE_FRAGMENT_SHADER = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() {
  fragColor = vec4(0.0);
}`;

const RENDER_VERTEX_SHADER = `#version 300 es
precision highp float;

layout(location = 0) in vec4 aPosEnergy;
layout(location = 1) in vec4 aVelSeed;

uniform float uAspect;
uniform vec2 uCursor;
uniform float uPointSize;
uniform vec4 uAudio;
uniform float uAudioSensitivity;

out float vSpeed;
out float vEnergy;
out vec3 vPos;
out float vSeed;

void main() {
  vec3 pos = aPosEnergy.xyz;
  vEnergy = aPosEnergy.w;
  vSpeed = length(aVelSeed.xyz);
  vPos = pos;
  vSeed = aVelSeed.w;

  // Subtle camera parallax tied to cursor
  vec3 viewPos = pos;
  viewPos.x -= uCursor.x * 0.08;
  viewPos.y -= uCursor.y * 0.08;

  float camZ = 3.1;
  float zDist = max(0.5, camZ - viewPos.z);
  float projScale = 2.05 / zDist;

  gl_Position = vec4(
    (viewPos.x * projScale) / max(0.1, uAspect),
    viewPos.y * projScale,
    clamp(-viewPos.z * 0.15, -0.95, 0.95),
    1.0
  );

  float audioBoost = 1.0 + (uAudio.w * 0.85 + uAudio.x * 0.45) * uAudioSensitivity;
  gl_PointSize = clamp(uPointSize * projScale * (0.72 + vEnergy * 0.65) * audioBoost, 1.2, 16.0);
}`;

function buildRenderFragmentShader(customColorGlsl: string): string {
  return `#version 300 es
precision highp float;

in float vSpeed;
in float vEnergy;
in vec3 vPos;
in float vSeed;

uniform vec4 uAudio;
uniform float uAudioSensitivity;
uniform vec3 uPrimaryColor;
uniform vec3 uAccentColor;

out vec4 fragColor;

${customColorGlsl}

void main() {
  vec2 uv = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(uv, uv);
  if (r2 > 1.0) discard;

  float alpha = exp(-r2 * 3.1) * (0.48 + vEnergy * 0.46);
  vec4 scaledAudio = uAudio * uAudioSensitivity;
  vec3 col = customColor(vSpeed, vEnergy, scaledAudio, vPos, vSeed, uPrimaryColor, uAccentColor);
  fragColor = vec4(col, clamp(alpha, 0.0, 1.0));
}`;
}

export interface ShaderCompileResult {
  ok: boolean;
  error?: string;
}

export class ParticleEngine {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext;

  private updateProgram: WebGLProgram | null = null;
  private renderProgram: WebGLProgram | null = null;

  private vboA: WebGLBuffer | null = null;
  private vboB: WebGLBuffer | null = null;
  private targetVbo: WebGLBuffer | null = null;
  private vaoA: WebGLVertexArrayObject | null = null;
  private vaoB: WebGLVertexArrayObject | null = null;
  private tf: WebGLTransformFeedback | null = null;

  private readIndex = 0;
  private config: PhysicsConfig;
  private forceCode = DEFAULT_FORCE_CODE;
  private colorCode = DEFAULT_COLOR_CODE;
  private customAnchors?: number[];

  private cursor = { x: 0, y: 0, vx: 0, vy: 0, down: 0 };
  private prevCursor = { x: 0, y: 0 };

  private startTime = performance.now();
  private lastFrameTime = performance.now();
  private rafId = 0;
  private contextLost = false;
  private reducedMotion = false;

  private fpsCounter = { frames: 0, lastSample: performance.now(), fps: 60 };
  private onContextStatus?: (lost: boolean) => void;
  private onFpsUpdate?: (fps: number) => void;

  constructor(
    canvas: HTMLCanvasElement,
    initialConfig: PhysicsConfig,
    callbacks?: {
      onContextStatus?: (lost: boolean) => void;
      onFpsUpdate?: (fps: number) => void;
    }
  ) {
    this.canvas = canvas;
    this.config = { ...initialConfig };
    this.onContextStatus = callbacks?.onContextStatus;
    this.onFpsUpdate = callbacks?.onFpsUpdate;
    this.reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });

    if (!gl) {
      throw new Error('WebGL2 is required for the GPU particle simulation.');
    }

    this.gl = gl;
    this.attachContextListeners();
    this.initResources();
  }

  private attachContextListeners(): void {
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextStatus?.(true);
    });

    this.canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.initResources();
      this.onContextStatus?.(false);
    });
  }

  private compileShader(type: number, source: string): { shader?: WebGLShader; error?: string } {
    const shader = this.gl.createShader(type);
    if (!shader) return { error: 'Failed to allocate WebGL shader object.' };
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(shader) || 'Unknown GLSL compile error.';
      this.gl.deleteShader(shader);
      return { error: info.trim() };
    }
    return { shader };
  }

  private buildProgram(
    vsSource: string,
    fsSource: string,
    transformVaryings?: string[]
  ): { program?: WebGLProgram; error?: string } {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    if (!vs.shader) return { error: vs.error };

    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    if (!fs.shader) {
      gl.deleteShader(vs.shader);
      return { error: fs.error };
    }

    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs.shader);
      gl.deleteShader(fs.shader);
      return { error: 'Failed to allocate WebGL program.' };
    }

    gl.attachShader(program, vs.shader);
    gl.attachShader(program, fs.shader);

    if (transformVaryings && transformVaryings.length > 0) {
      gl.transformFeedbackVaryings(program, transformVaryings, gl.INTERLEAVED_ATTRIBS);
    }

    gl.linkProgram(program);
    gl.deleteShader(vs.shader);
    gl.deleteShader(fs.shader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program) || 'Program link failed.';
      gl.deleteProgram(program);
      return { error: info.trim() };
    }

    return { program };
  }

  private initResources(): void {
    const gl = this.gl;

    // Compile initial programs
    const updateRes = this.buildProgram(
      buildUpdateVertexShader(this.forceCode),
      UPDATE_FRAGMENT_SHADER,
      ['vPosEnergy', 'vVelSeed']
    );
    if (!updateRes.program) {
      throw new Error(`Initial update shader failed: ${updateRes.error}`);
    }

    const renderRes = this.buildProgram(
      RENDER_VERTEX_SHADER,
      buildRenderFragmentShader(this.colorCode)
    );
    if (!renderRes.program) {
      throw new Error(`Initial render shader failed: ${renderRes.error}`);
    }

    this.updateProgram = updateRes.program;
    this.renderProgram = renderRes.program;

    // Initialize 65,536 particles (8 floats per particle: pos.xyz, energy, vel.xyz, seed)
    const initialState = new Float32Array(MAX_PARTICLES * 8);
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const idx = i * 8;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 0.25 + Math.cbrt(Math.random()) * 1.05;
      initialState[idx] = r * Math.sin(phi) * Math.cos(theta);
      initialState[idx + 1] = r * Math.sin(phi) * Math.sin(theta);
      initialState[idx + 2] = r * Math.cos(phi);
      initialState[idx + 3] = Math.random() * 0.5;
      initialState[idx + 4] = (Math.random() - 0.5) * 0.1;
      initialState[idx + 5] = (Math.random() - 0.5) * 0.1;
      initialState[idx + 6] = (Math.random() - 0.5) * 0.1;
      initialState[idx + 7] = i / MAX_PARTICLES;
    }

    this.vboA = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboA);
    gl.bufferData(gl.ARRAY_BUFFER, initialState, gl.DYNAMIC_COPY);

    this.vboB = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vboB);
    gl.bufferData(gl.ARRAY_BUFFER, initialState, gl.DYNAMIC_COPY);

    const targets = buildFormationTargets(this.config.formation, MAX_PARTICLES, this.customAnchors);
    this.targetVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.targetVbo);
    gl.bufferData(gl.ARRAY_BUFFER, targets, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.vaoA = this.setupVao(this.vboA!);
    this.vaoB = this.setupVao(this.vboB!);
    this.tf = gl.createTransformFeedback();
    this.readIndex = 0;
  }

  private setupVao(stateBuffer: WebGLBuffer): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, stateBuffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.targetVbo);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 12, 0);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    return vao;
  }

  public updateShaders(forceCode: string, colorCode: string): ShaderCompileResult {
    const nextUpdate = this.buildProgram(
      buildUpdateVertexShader(forceCode),
      UPDATE_FRAGMENT_SHADER,
      ['vPosEnergy', 'vVelSeed']
    );
    if (!nextUpdate.program) {
      return { ok: false, error: `Force shader error: ${nextUpdate.error}` };
    }

    const nextRender = this.buildProgram(
      RENDER_VERTEX_SHADER,
      buildRenderFragmentShader(colorCode)
    );
    if (!nextRender.program) {
      this.gl.deleteProgram(nextUpdate.program);
      return { ok: false, error: `Color shader error: ${nextRender.error}` };
    }

    if (this.updateProgram) this.gl.deleteProgram(this.updateProgram);
    if (this.renderProgram) this.gl.deleteProgram(this.renderProgram);

    this.updateProgram = nextUpdate.program;
    this.renderProgram = nextRender.program;
    this.forceCode = forceCode;
    this.colorCode = colorCode;
    return { ok: true };
  }

  public updateConfig(next: Partial<PhysicsConfig>): void {
    const prevFormation = this.config.formation;
    this.config = { ...this.config, ...next };
    if (next.formation && next.formation !== prevFormation) {
      this.uploadFormationTargets(next.formation, this.customAnchors);
    }
  }

  public setCustomTargets(anchorTriplets: number[], formation: FormationId = 'custom'): void {
    this.customAnchors = anchorTriplets;
    this.config.formation = formation;
    if (this.config.morphStrength < 0.2) {
      this.config.morphStrength = 0.72;
    }
    this.uploadFormationTargets(formation, anchorTriplets);
  }

  private uploadFormationTargets(formation: FormationId, customAnchors?: number[]): void {
    if (!this.targetVbo) return;
    const targets = buildFormationTargets(formation, MAX_PARTICLES, customAnchors);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.targetVbo);
    this.gl.bufferSubData(this.gl.ARRAY_BUFFER, 0, targets);
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, null);
  }

  public setCursor(nx: number, ny: number, downState: number): void {
    this.cursor.x = nx;
    this.cursor.y = ny;
    this.cursor.down = downState;
  }

  public resize(width: number, height: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(width * dpr));
    const h = Math.max(1, Math.floor(height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  public start(getAudioMetrics: () => AudioMetrics): void {
    const renderLoop = (now: number) => {
      this.rafId = requestAnimationFrame(renderLoop);
      if (this.contextLost) return;

      const rawDt = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;
      const dt = this.reducedMotion ? Math.min(rawDt, 0.016) * 0.25 : Math.min(rawDt, 0.033);
      const elapsed = (now - this.startTime) / 1000;

      // Cursor velocity smoothed
      this.cursor.vx = (this.cursor.x - this.prevCursor.x) * 0.55 + this.cursor.vx * 0.45;
      this.cursor.vy = (this.cursor.y - this.prevCursor.y) * 0.55 + this.cursor.vy * 0.45;
      this.prevCursor.x = this.cursor.x;
      this.prevCursor.y = this.cursor.y;

      const audio = getAudioMetrics();
      this.stepAndDraw(elapsed, dt, audio);

      // FPS sampling
      this.fpsCounter.frames++;
      if (now - this.fpsCounter.lastSample >= 500) {
        const fps = Math.round(
          (this.fpsCounter.frames * 1000) / (now - this.fpsCounter.lastSample)
        );
        this.fpsCounter.fps = fps;
        this.fpsCounter.frames = 0;
        this.fpsCounter.lastSample = now;
        this.onFpsUpdate?.(fps);
      }
    };

    this.lastFrameTime = performance.now();
    this.rafId = requestAnimationFrame(renderLoop);
  }

  private stepAndDraw(elapsed: number, dt: number, audio: AudioMetrics): void {
    const gl = this.gl;
    if (!this.updateProgram || !this.renderProgram || !this.tf) return;

    const count = Math.min(this.config.particleCount, MAX_PARTICLES);
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);

    const readVao = this.readIndex === 0 ? this.vaoA : this.vaoB;
    const writeVbo = this.readIndex === 0 ? this.vboB : this.vboA;
    const drawVao = this.readIndex === 0 ? this.vaoB : this.vaoA;

    // Pass 1: GPU Transform Feedback Physics Simulation
    gl.useProgram(this.updateProgram);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uTime'), elapsed);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uDt'), dt);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uAspect'), aspect);
    gl.uniform2f(gl.getUniformLocation(this.updateProgram, 'uCursor'), this.cursor.x, this.cursor.y);
    gl.uniform2f(gl.getUniformLocation(this.updateProgram, 'uCursorVel'), this.cursor.vx, this.cursor.vy);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uCursorDown'), this.cursor.down);
    gl.uniform4f(
      gl.getUniformLocation(this.updateProgram, 'uAudio'),
      audio.bass,
      audio.mid,
      audio.treble,
      audio.cadence
    );
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uCurlStrength'), this.config.curlStrength);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uViscosity'), this.config.viscosity);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uCursorRadius'), this.config.cursorRadius);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uCursorForce'), this.config.cursorForce);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uMorphStrength'), this.config.morphStrength);
    gl.uniform1f(gl.getUniformLocation(this.updateProgram, 'uAudioSensitivity'), this.config.audioSensitivity);

    gl.bindVertexArray(readVao);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, this.tf);
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, writeVbo);

    gl.enable(gl.RASTERIZER_DISCARD);
    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.endTransformFeedback();
    gl.disable(gl.RASTERIZER_DISCARD);

    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
    gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
    gl.bindVertexArray(null);

    // Pass 2: Luminous Particle Rendering
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.027, 0.035, 0.055, 1.0); // #07090E obsidian
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);

    gl.useProgram(this.renderProgram);
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'uAspect'), aspect);
    gl.uniform2f(gl.getUniformLocation(this.renderProgram, 'uCursor'), this.cursor.x, this.cursor.y);
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'uPointSize'), this.config.pointSize);
    gl.uniform4f(
      gl.getUniformLocation(this.renderProgram, 'uAudio'),
      audio.bass,
      audio.mid,
      audio.treble,
      audio.cadence
    );
    gl.uniform1f(gl.getUniformLocation(this.renderProgram, 'uAudioSensitivity'), this.config.audioSensitivity);

    const [pr, pg, pb] = hexToRgbTuple(this.config.primaryColor);
    const [ar, ag, ab] = hexToRgbTuple(this.config.accentColor);
    gl.uniform3f(gl.getUniformLocation(this.renderProgram, 'uPrimaryColor'), pr, pg, pb);
    gl.uniform3f(gl.getUniformLocation(this.renderProgram, 'uAccentColor'), ar, ag, ab);

    gl.bindVertexArray(drawVao);
    gl.drawArrays(gl.POINTS, 0, count);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);

    this.readIndex = 1 - this.readIndex;
  }

  public dispose(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    const gl = this.gl;
    if (this.updateProgram) gl.deleteProgram(this.updateProgram);
    if (this.renderProgram) gl.deleteProgram(this.renderProgram);
    if (this.vboA) gl.deleteBuffer(this.vboA);
    if (this.vboB) gl.deleteBuffer(this.vboB);
    if (this.targetVbo) gl.deleteBuffer(this.targetVbo);
    if (this.vaoA) gl.deleteVertexArray(this.vaoA);
    if (this.vaoB) gl.deleteVertexArray(this.vaoB);
    if (this.tf) gl.deleteTransformFeedback(this.tf);
  }
}
