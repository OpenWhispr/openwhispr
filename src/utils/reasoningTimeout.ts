import { REQUEST_TIMEOUTS } from "../config/constants";

// Resolves the non-streaming reasoning request timeout. A positive
// reasoningTimeoutMs setting wins; anything else (0, unset, NaN, negative)
// falls back to the default so a hand-edited localStorage value can never
// disable the timeout entirely.
export function resolveReasoningTimeoutMs(reasoningTimeoutMs: unknown): number {
  const value = Number(reasoningTimeoutMs);
  return Number.isFinite(value) && value > 0 ? value : REQUEST_TIMEOUTS.REASONING;
}
