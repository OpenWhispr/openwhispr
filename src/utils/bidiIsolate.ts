const FIRST_STRONG_ISOLATE = "⁨";
const POP_DIRECTIONAL_ISOLATE = "⁩";

/**
 * Wraps a value in Unicode isolates so an address or a name keeps its own direction inside a
 * translated sentence, in plain-string slots (titles, toasts, tooltips) where <bdi> can't go.
 */
export function isolate(value: string): string {
  return `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`;
}
