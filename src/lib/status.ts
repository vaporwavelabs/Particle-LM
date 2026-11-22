export const STATUS_MODES = [
  'online',
  'fallback',
  'failing',
  'offline',
  'disabled',
  'model-missing',
  'misconfigured',
] as const;

export interface LlmStatus {
  mode: (typeof STATUS_MODES)[number] | 'unknown';
  model?: string;
  primary?: 'ok' | 'stalled' | 'down' | 'unknown';
  notice?: string;
}

export type StatusTone = 'green' | 'amber' | 'grey';

/** Human label + colour for the status pill. Green only when the primary LLM is really answering. */
export function describeStatus(s: LlmStatus): { label: string; tone: StatusTone } {
  const model = s.model ?? '';
  switch (s.mode) {
    case 'online':
      return { label: `Local LLM · ${model}`, tone: 'green' };
    case 'fallback':
      return {
        label: `Primary ${s.primary === 'stalled' ? 'stalled' : s.primary === 'down' ? 'down' : 'unavailable'}, using fallback · ${model}`,
        tone: 'amber',
      };
    case 'failing':
      return {
        label: s.primary === 'stalled' ? 'Primary stalled · last prompt used offline parser' : 'LLM not answering · offline parser',
        tone: 'amber',
      };
    case 'offline':
      return { label: 'Local LLM unreachable · offline parser', tone: 'amber' };
    case 'disabled':
      return { label: 'Offline parser (LLM disabled)', tone: 'amber' };
    case 'model-missing':
      return { label: `Model missing · ${model}`, tone: 'amber' };
    case 'misconfigured':
      return { label: 'LLM misconfigured (check .env) · offline parser', tone: 'amber' };
    default:
      return { label: 'Checking local LLM…', tone: 'grey' };
  }
}
