import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, LIMITS, cleanText, normalizeColor, sanitizeParams, darkenBackground, PRESETS } from '../shared/params.ts';

describe('sanitizeParams', () => {
  it('accepts a valid object', () => {
    const { params, reply, issues } = sanitizeParams({ shape: 'heart', behavior: 'pulse', primary: '#FF0000', reply: 'Hi' });
    expect(params.shape).toBe('heart');
    expect(params.behavior).toBe('pulse');
    expect(params.primary).toBe('#ff0000');
    expect(reply).toBe('Hi');
    expect(issues).toEqual([]);
  });

  it('clamps out-of-range numbers and records issues', () => {
    const { params, issues } = sanitizeParams({ speed: 99, size: -5, turbulence: '1.5', shapeStrength: 7, force: 0 });
    expect(params.speed).toBe(LIMITS.speed[1]);
    expect(params.size).toBe(LIMITS.size[0]);
    expect(params.turbulence).toBe(1.5);
    expect(params.shapeStrength).toBe(1);
    expect(params.force).toBe(LIMITS.force[0]);
    expect(issues).toEqual(expect.arrayContaining(['speed clamped', 'size clamped', 'shapeStrength clamped', 'force clamped']));
  });

  it('rejects unknown enums, bad colours, NaN/Infinity and non-objects', () => {
    const { params, issues } = sanitizeParams({ shape: 'pyramid', behavior: 'rm -rf', primary: 'javascript:alert(1)', speed: Infinity, size: NaN });
    expect(params.shape).toBe(DEFAULT_PARAMS.shape);
    expect(params.behavior).toBe(DEFAULT_PARAMS.behavior);
    expect(params.primary).toBe(DEFAULT_PARAMS.primary);
    expect(params.speed).toBe(DEFAULT_PARAMS.speed);
    expect(params.size).toBe(DEFAULT_PARAMS.size);
    expect(issues).toEqual(expect.arrayContaining(['shape', 'behavior', 'primary']));
    expect(sanitizeParams('nope').params).toEqual(DEFAULT_PARAMS);
    expect(sanitizeParams([1, 2]).params).toEqual(DEFAULT_PARAMS);
    expect(sanitizeParams(null).params).toEqual(DEFAULT_PARAMS);
  });

  it('drops unknown keys (no prototype pollution / extra fields)', () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "evil": "<img src=x onerror=alert(1)>", "shape": "ring"}');
    const { params } = sanitizeParams(raw);
    expect(Object.keys(params).sort()).toEqual(Object.keys(DEFAULT_PARAMS).sort());
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(params.shape).toBe('ring');
  });

  it('keeps HTML as inert text, strips control chars and caps length', () => {
    const { reply, params } = sanitizeParams({ reply: `<script>alert(1)</script>\u0000\u2028 ok ${'x'.repeat(1000)}`, label: 'a'.repeat(200) });
    expect(reply.startsWith('<script>alert(1)</script> ok')).toBe(true); // rendered as text by React, never as HTML
    expect(reply.length).toBeLessThanOrEqual(280);
    expect(params.label.length).toBeLessThanOrEqual(40);
    expect(cleanText('a\u0007b', 10)).toBe('a b');
  });

  it('normalises colour names and keeps backgrounds dark', () => {
    expect(normalizeColor('neon pink')).toBe('#ff2fd0');
    expect(normalizeColor('#abc')).toBe('#aabbcc');
    expect(normalizeColor('rgb(1,2,3)')).toBeUndefined();
    const bg = darkenBackground('#ffffff');
    const lum = parseInt(bg.slice(1, 3), 16) / 255;
    expect(lum).toBeLessThan(0.2);
    expect(sanitizeParams({ background: '#ffffff' }).params.background).toBe(bg);
  });

  it('presets are valid params', () => {
    for (const p of PRESETS) expect(sanitizeParams(p.params).params).toEqual({ ...p.params, background: darkenBackground(p.params.background) });
  });
});
