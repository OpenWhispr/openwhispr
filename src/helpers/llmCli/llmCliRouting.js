// ESM, pure (no React, no Electron): which inference provider ids are CLI seats,
// which seats a scope may offer, and whether one is usable right now. The
// scope allowlist lives in llmCliProviders.js (D-03): chat and the dictation
// agent only, never cleanup, vision or note formatting.
import { LLM_CLI_PROVIDERS, cliProviderIdsForScope } from "../llmCliProviders.js";

/** Stored in the model field when the user wants the CLI's own default model. */
export const CLI_DEFAULT_MODEL = "default";

export function isCliProviderId(id) {
  return typeof id === "string" && LLM_CLI_PROVIDERS.some((p) => p.id === id);
}

export function cliSeatForProviderId(id) {
  return LLM_CLI_PROVIDERS.find((p) => p.id === id)?.seat ?? null;
}

/** Model id for the IPC payload: the CLI default is expressed by sending none. */
export function cliModelIdFor(model) {
  return typeof model === "string" && model && model !== CLI_DEFAULT_MODEL ? model : undefined;
}

/**
 * Seats the provider picker offers for a scope: enabled by the main-held prefs
 * (the Claude gate) and currently signed in.
 */
export function cliPickerSeats(scope, prefs, seatStates) {
  const ids = new Set(cliProviderIdsForScope(scope, prefs));
  return LLM_CLI_PROVIDERS.filter(
    (p) => ids.has(p.id) && seatStates?.[p.seat]?.status === "signed-in"
  ).map((p) => ({ id: p.id, seat: p.seat, label: p.label, models: [...p.models] }));
}

/** False for any scope the allowlist excludes, a gated Claude seat, or a seat that is not signed in. */
export function isCliProviderAvailable(providerId, scope, prefs, seatStates) {
  return cliPickerSeats(scope, prefs, seatStates).some((s) => s.id === providerId);
}
