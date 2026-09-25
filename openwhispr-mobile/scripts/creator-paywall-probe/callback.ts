import type { CustomCallback, CustomCallbackResult } from 'expo-superwall';

export const PROBE_PLACEMENT = 'creator_code_probe_20260925';
export const PROBE_MARKER = 'DEMO_ONLY';

// Probe data never enters the real affiliate parser, claim service or Apple handoff.
export function createProbeCallback(onShape: (shape: string[]) => void) {
  let active = true;
  return {
    close() {
      active = false;
    },
    async handle(callback: CustomCallback): Promise<CustomCallbackResult> {
      if (!active) return { status: 'failure' };
      const shape: string[] = [];
      let hasMarker = false;
      const inspect = (value: unknown, path: string, depth: number): void => {
        if (depth > 6 || shape.length >= 40) return;
        if (value === PROBE_MARKER) hasMarker = true;
        shape.push(
          `${path}: ${value === null ? 'null' : typeof value}${value === PROBE_MARKER ? ' (fixture)' : ''}`,
        );
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [key, child] of Object.entries(value)) {
            inspect(child, `${path}.${key}`, depth + 1);
          }
        }
      };
      inspect(callback.variables, 'variables', 0);
      onShape(shape);
      if (callback.name !== 'creatorCodeApply' || !hasMarker) {
        return {
          status: 'failure',
          data: { message: 'TEST ONLY: enter DEMO_ONLY. No payment is available.' },
        };
      }
      // Deliberate latency exercises dismissal and the editor's checking state.
      await new Promise<void>((resolve) => setTimeout(resolve, 700));
      if (!active) return { status: 'failure' };
      return {
        status: 'success',
        data: {
          priceText: 'TEST $7.99',
          renewalText: 'TEST ONLY — fictional price; no subscription or offer.',
        },
      };
    },
  };
}
