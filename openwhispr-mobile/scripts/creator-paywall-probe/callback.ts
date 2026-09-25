import type { CustomCallback, CustomCallbackResult } from 'expo-superwall';

export const PROBE_PLACEMENT = 'creator_code_probe_20260925';
export const PROBE_MARKER = 'DEMO_ONLY';
export const PROBE_TOKEN = 'FICTIONAL_PRESENTATION_TOKEN';
export type ProbeScenario =
  | 'valid'
  | 'seed'
  | 'seed-missing'
  | 'retry-missing'
  | 'missing'
  | 'malformed'
  | 'failure'
  | 'slow';

export function probeParams(scenario: ProbeScenario) {
  return {
    creator_probe: 'fixture_20260925',
    affiliate_entry: scenario.startsWith('seed') ? 'account' : 'cloud',
    ...(scenario.startsWith('seed')
      ? {
          creator_offer_ready: true,
          creator_offer_price: 'TEST $7.99',
          creator_offer_renewal: 'TEST ONLY — fictional price; no subscription or offer.',
          creator_offer_token: scenario === 'seed' ? PROBE_TOKEN : '',
        }
      : {
          creator_offer_ready: false,
          creator_offer_price: '',
          creator_offer_renewal: '',
          creator_offer_token: '',
        }),
  };
}

// Probe data never enters the real affiliate parser, claim service or Apple handoff.
export function createProbeCallback(
  onShape: (shape: string[]) => void,
  scenario: ProbeScenario = 'valid',
) {
  let active = true;
  let applies = 0;
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
      onShape([`Callback: ${callback.name}`, ...shape]);
      if (callback.name !== 'creatorCodeApply' || !hasMarker) {
        return {
          status: 'failure',
          data: { message: 'TEST ONLY: enter DEMO_ONLY. No payment is available.' },
        };
      }
      applies += 1;
      // Deliberate latency exercises dismissal and the editor's checking state.
      await new Promise<void>((resolve) => setTimeout(resolve, scenario === 'slow' ? 15000 : 700));
      if (!active) return { status: 'failure' };
      if (scenario === 'failure')
        return { status: 'failure', data: { message: 'TEST ONLY: simulated unavailable offer.' } };
      return {
        status: 'success',
        data: {
          priceText: scenario === 'malformed' ? 799 : 'TEST $7.99',
          renewalText: 'TEST ONLY — fictional price; no subscription or offer.',
          ...(scenario === 'missing' || (scenario === 'retry-missing' && applies > 1)
            ? {}
            : { offerToken: PROBE_TOKEN }),
        },
      };
    },
  };
}
