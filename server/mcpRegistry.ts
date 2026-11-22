import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import vm from 'node:vm';

export interface McpToolExecutionResult {
  toolName: string;
  args: Record<string, unknown>;
  resultSummary: string;
  durationMs: number;
  status: 'ok' | 'error';
  payload: {
    shaderUpdate?: {
      forceCode?: string;
      colorCode?: string;
      label?: string;
    };
    physicsUpdate?: Record<string, unknown>;
    customTargets?: number[];
    dataOutput?: unknown;
  };
}

export const mcpToolDeclarations: FunctionDeclaration[] = [
  {
    name: 'mutate_glsl_shader',
    description:
      'Rewrite and hot-swap the live WebGL2 GLSL customForce and/or customColor shader functions for the 65,536-particle fluid engine.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        label: {
          type: Type.STRING,
          description: 'Short 2-4 word name for this shader mutation (e.g. "Harmonic Spiral Field").',
        },
        forceCode: {
          type: Type.STRING,
          description:
            'Complete GLSL ES 3.00 function with exact signature: vec3 customForce(vec3 pos, vec3 vel, float time, vec4 audio, vec2 cursor, float cursorDown, float seed) { ... return vec3(...); }. Use audio.x (bass), audio.y (mid), audio.z (treble), audio.w (cadence pulse). Avoid division by zero.',
        },
        colorCode: {
          type: Type.STRING,
          description:
            'Complete GLSL ES 3.00 function with exact signature: vec3 customColor(float speed, float energy, vec4 audio, vec3 pos, float seed, vec3 primaryCol, vec3 accentCol) { ... return vec3(...); }.',
        },
      },
    },
  },
  {
    name: 'run_data_processor',
    description:
      'Execute sandboxed JavaScript mathematical/data-processing code via MCP to generate custom 3D particle attractor coordinates or wave harmonics.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        description: {
          type: Type.STRING,
          description: 'Short description of the mathematical structure or dataset being computed.',
        },
        code: {
          type: Type.STRING,
          description:
            'JavaScript code body that computes up to 2048 3D points. Must return an array of [x, y, z] triplets or call emitPoint(x, y, z) inside a loop. Coordinates should stay roughly within [-1.4, 1.4]. Example: for (let i = 0; i < 1200; i++) { const t = i * 0.05; emitPoint(Math.cos(t), Math.sin(t*1.5)*0.6, Math.sin(t)); }',
        },
        morphStrength: {
          type: Type.NUMBER,
          description: 'How strongly particles imitate the generated points, between 0.0 (free fluid) and 1.0 (tight lock).',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'morph_formation_shape',
    description:
      'Morph the fluid particles to imitate a built-in geometric formation or release them back into free curl fluid.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        formation: {
          type: Type.STRING,
          description: 'One of: fluid, torus, helix, mandala, lattice, custom.',
        },
        morphStrength: {
          type: Type.NUMBER,
          description: 'Morph attraction strength from 0.0 (pure fluid) to 1.0 (sharp geometric form).',
        },
      },
      required: ['formation'],
    },
  },
  {
    name: 'set_simulation_physics',
    description:
      'Adjust particle fluid physics uniforms, cursor interaction radius/force, audio chant sensitivity, or color palette.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        curlStrength: { type: Type.NUMBER, description: 'Fluid curl turbulence intensity (0.0 to 3.5).' },
        viscosity: { type: Type.NUMBER, description: 'Velocity damping factor (0.80 to 0.99).' },
        cursorRadius: { type: Type.NUMBER, description: 'Cursor influence radius (0.15 to 1.5).' },
        cursorForce: { type: Type.NUMBER, description: 'Cursor swirl/push force (0.2 to 6.0).' },
        audioSensitivity: { type: Type.NUMBER, description: 'Voice chant FFT multiplier (0.0 to 3.5).' },
        pointSize: { type: Type.NUMBER, description: 'Particle size in pixels (1.0 to 5.5).' },
        primaryColor: { type: Type.STRING, description: 'Hex color string like #06B6D4.' },
        accentColor: { type: Type.STRING, description: 'Hex color string like #F59E0B.' },
      },
    },
  },
];

function stripMarkdownFences(raw: string): string {
  return raw
    .replace(/^```[a-zA-Z]*\n?/gm, '')
    .replace(/```$/gm, '')
    .trim();
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isValidHex(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.trim());
}

export function runSandboxedDataProcessor(code: string): {
  triplets: number[];
  logs: string[];
  pointCount: number;
} {
  const collected: number[] = [];
  const logs: string[] = [];
  const MAX_POINTS = 4096;

  const emitPoint = (x: number, y: number, z: number) => {
    if (collected.length >= MAX_POINTS * 3) return;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      collected.push(clamp(x, -2.0, 2.0), clamp(y, -2.0, 2.0), clamp(z, -2.0, 2.0));
    }
  };

  const sandbox = {
    Math,
    Number,
    Array,
    Float32Array,
    JSON,
    emitPoint,
    console: {
      log: (...items: unknown[]) => {
        if (logs.length < 12) {
          logs.push(items.map((v) => String(v)).join(' '));
        }
      },
    },
  };

  const context = vm.createContext(sandbox);
  const cleanCode = stripMarkdownFences(code);
  const wrapped = `(function() {\n${cleanCode}\n})()`;

  const result = vm.runInContext(wrapped, context, { timeout: 250 });

  if (collected.length === 0 && Array.isArray(result)) {
    for (let i = 0; i < result.length && collected.length < MAX_POINTS * 3; i++) {
      const item = result[i];
      if (Array.isArray(item) && item.length >= 3) {
        emitPoint(Number(item[0]), Number(item[1]), Number(item[2]));
      }
    }
  }

  return {
    triplets: collected,
    logs,
    pointCount: Math.floor(collected.length / 3),
  };
}

export function executeMcpTool(
  toolName: string,
  args: Record<string, unknown>
): McpToolExecutionResult {
  const started = performance.now();

  try {
    switch (toolName) {
      case 'mutate_glsl_shader': {
        const shaderUpdate: { forceCode?: string; colorCode?: string; label?: string } = {};
        if (typeof args.label === 'string' && args.label.trim()) {
          shaderUpdate.label = args.label.trim().slice(0, 48);
        }
        if (typeof args.forceCode === 'string' && args.forceCode.trim()) {
          const force = stripMarkdownFences(args.forceCode);
          if (!force.includes('customForce')) {
            throw new Error('forceCode must define vec3 customForce(...)');
          }
          shaderUpdate.forceCode = force;
        }
        if (typeof args.colorCode === 'string' && args.colorCode.trim()) {
          const color = stripMarkdownFences(args.colorCode);
          if (!color.includes('customColor')) {
            throw new Error('colorCode must define vec3 customColor(...)');
          }
          shaderUpdate.colorCode = color;
        }
        if (!shaderUpdate.forceCode && !shaderUpdate.colorCode) {
          throw new Error('Provide forceCode and/or colorCode.');
        }
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        return {
          toolName,
          args,
          resultSummary: `Prepared GLSL mutation${shaderUpdate.label ? ` (${shaderUpdate.label})` : ''}`,
          durationMs,
          status: 'ok',
          payload: { shaderUpdate },
        };
      }

      case 'run_data_processor': {
        const code = typeof args.code === 'string' ? args.code : '';
        if (!code.trim()) {
          throw new Error('Data processor requires a JavaScript code string.');
        }
        const { triplets, logs, pointCount } = runSandboxedDataProcessor(code);
        if (pointCount === 0) {
          throw new Error('Script completed but emitted 0 valid 3D points.');
        }
        const morphStrength =
          typeof args.morphStrength === 'number'
            ? clamp(args.morphStrength, 0, 1)
            : 0.78;
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        return {
          toolName,
          args,
          resultSummary: `Computed ${pointCount} 3D attractor points in ${durationMs}ms`,
          durationMs,
          status: 'ok',
          payload: {
            customTargets: triplets,
            physicsUpdate: { formation: 'custom', morphStrength },
            dataOutput: { pointCount, logs },
          },
        };
      }

      case 'morph_formation_shape': {
        const allowed = new Set(['fluid', 'torus', 'helix', 'mandala', 'lattice', 'custom']);
        const formation = typeof args.formation === 'string' && allowed.has(args.formation)
          ? args.formation
          : 'fluid';
        const defaultMorph = formation === 'fluid' ? 0.0 : 0.76;
        const morphStrength =
          typeof args.morphStrength === 'number'
            ? clamp(args.morphStrength, 0, 1)
            : defaultMorph;
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        return {
          toolName,
          args,
          resultSummary: `Morphed target field to ${formation} (${Math.round(morphStrength * 100)}% lock)`,
          durationMs,
          status: 'ok',
          payload: {
            physicsUpdate: { formation, morphStrength },
          },
        };
      }

      case 'set_simulation_physics': {
        const physicsUpdate: Record<string, unknown> = {};
        if (typeof args.curlStrength === 'number') {
          physicsUpdate.curlStrength = clamp(args.curlStrength, 0, 3.5);
        }
        if (typeof args.viscosity === 'number') {
          physicsUpdate.viscosity = clamp(args.viscosity, 0.8, 0.99);
        }
        if (typeof args.cursorRadius === 'number') {
          physicsUpdate.cursorRadius = clamp(args.cursorRadius, 0.15, 1.5);
        }
        if (typeof args.cursorForce === 'number') {
          physicsUpdate.cursorForce = clamp(args.cursorForce, 0.2, 6.0);
        }
        if (typeof args.audioSensitivity === 'number') {
          physicsUpdate.audioSensitivity = clamp(args.audioSensitivity, 0, 3.5);
        }
        if (typeof args.pointSize === 'number') {
          physicsUpdate.pointSize = clamp(args.pointSize, 1.0, 5.5);
        }
        if (isValidHex(args.primaryColor)) {
          physicsUpdate.primaryColor = args.primaryColor.trim();
        }
        if (isValidHex(args.accentColor)) {
          physicsUpdate.accentColor = args.accentColor.trim();
        }
        const keys = Object.keys(physicsUpdate);
        if (keys.length === 0) {
          throw new Error('No valid physics parameters supplied.');
        }
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        return {
          toolName,
          args,
          resultSummary: `Updated physics uniforms: ${keys.join(', ')}`,
          durationMs,
          status: 'ok',
          payload: { physicsUpdate },
        };
      }

      default:
        throw new Error(`Unknown MCP tool: ${toolName}`);
    }
  } catch (err) {
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const message = err instanceof Error ? err.message : 'MCP execution failed';
    return {
      toolName,
      args,
      resultSummary: message,
      durationMs,
      status: 'error',
      payload: {},
    };
  }
}
