export type FormationId =
  | 'fluid'
  | 'torus'
  | 'helix'
  | 'mandala'
  | 'lattice'
  | 'custom';

export type VoicePersona = 'Kore' | 'Fenrir' | 'Puck' | 'Charon' | 'Zephyr';

export type StudioMode = 'fluid' | 'morph' | 'chant' | 'shader';

export interface PhysicsConfig {
  particleCount: 16384 | 32768 | 65536;
  formation: FormationId;
  curlStrength: number;
  viscosity: number;
  cursorRadius: number;
  cursorForce: number;
  morphStrength: number;
  audioSensitivity: number;
  pointSize: number;
  primaryColor: string;
  accentColor: string;
}

export interface ShaderCodeConfig {
  forceCode: string;
  colorCode: string;
  label: string;
}

export interface AudioMetrics {
  bass: number;
  mid: number;
  treble: number;
  cadence: number;
  pitchHz: number;
  level: number;
  spectrum: number[];
  source: 'idle' | 'mic' | 'tts';
}

export interface McpToolCallRecord {
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
  status: 'ok' | 'error';
  timestamp: string;
}

export interface AgentCommandResponse {
  transcript: string;
  replyText: string;
  audioBase64?: string;
  audioMimeType?: string;
  toolCalls: McpToolCallRecord[];
  shaderUpdate?: Partial<ShaderCodeConfig>;
  physicsUpdate?: Partial<PhysicsConfig>;
  customTargets?: number[];
  error?: string;
}

export const DEFAULT_FORCE_CODE = `vec3 customForce(vec3 pos, vec3 vel, float time, vec4 audio, vec2 cursor, float cursorDown, float seed) {
  // Harmonic chant vortex + gentle orbital drift
  float r = length(pos.xz) + 0.001;
  vec3 tangent = vec3(-pos.z / r, 0.0, pos.x / r);
  float chantWave = sin(r * 4.5 - time * 3.0 + seed * 6.2831) * (audio.x * 1.4 + audio.w * 1.8);
  vec3 radialPulse = normalize(pos + vec3(0.0001)) * chantWave * 0.45;
  return tangent * (0.28 + audio.y * 0.65) + radialPulse;
}`;

export const DEFAULT_COLOR_CODE = `vec3 customColor(float speed, float energy, vec4 audio, vec3 pos, float seed, vec3 primaryCol, vec3 accentCol) {
  float velocityMix = clamp(speed * 0.55 + energy * 0.45, 0.0, 1.0);
  float audioFlare = clamp(audio.w * 0.85 + audio.z * 0.45, 0.0, 1.0);
  vec3 core = mix(primaryCol, accentCol, clamp(velocityMix * 0.65 + audioFlare * 0.5, 0.0, 1.0));
  return core * (0.68 + energy * 0.55 + audio.x * 0.35);
}`;

export const DEFAULT_PHYSICS: PhysicsConfig = {
  particleCount: 65536,
  formation: 'fluid',
  curlStrength: 1.15,
  viscosity: 0.94,
  cursorRadius: 0.58,
  cursorForce: 2.4,
  morphStrength: 0.0,
  audioSensitivity: 1.35,
  pointSize: 2.35,
  primaryColor: '#06B6D4',
  accentColor: '#F59E0B',
};
