import { describe, expect, it } from 'vitest';
import { parsePromptOffline } from '../server/llm/offline.ts';
import { sanitizeParams } from '../shared/params.ts';

describe('offline parser', () => {
  it.each([
    ['galaxy spiral in neon pink', 'galaxy', 'orbit', '#ff2fd0'],
    ['a beating red heart', 'heart', 'pulse', '#ef4444'],
    ['storm', 'nebula', 'storm', undefined],
    ['golden tornado', 'tornado', 'swirl', '#fbbf24'],
    ['calm blue ocean waves', 'wave', 'flow', '#3b82f6'],
    ['green dna helix', 'helix', 'orbit', '#22c55e'],
    ['exploding firework', 'star', 'explode', undefined],
  ])('%s', (prompt, shape, behavior, primary) => {
    const r = parsePromptOffline(prompt);
    expect(r.source).toBe('offline');
    expect(r.params.shape).toBe(shape);
    expect(r.params.behavior).toBe(behavior);
    if (primary) expect(r.params.primary).toBe(primary);
    // always valid against the shared contract
    expect(sanitizeParams(r.params).issues).toEqual([]);
  });

  it('handles gibberish with defaults', () => {
    const r = parsePromptOffline('qwzx plorb');
    expect(r.params.shape).toBe('nebula');
    expect(r.reply).toMatch(/Offline parser/);
  });

  it('speed modifiers stay in range', () => {
    expect(parsePromptOffline('fast crazy storm').params.speed).toBeLessThanOrEqual(3);
    expect(parsePromptOffline('slow sleepy cloud').params.speed).toBeGreaterThanOrEqual(0.1);
  });
});
