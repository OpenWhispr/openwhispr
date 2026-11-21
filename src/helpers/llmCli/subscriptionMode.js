// ESM, pure (no React, no Electron): the "Subscription" mode card of the LLM scope editor.
// Stored config is unchanged: a CLI seat is mode "providers" + a CLI provider id. The card is a
// derived view over that, so it never needs a new stored mode value.
import { CLI_SCOPE_ALLOWLIST } from "../llmCliProviders.js";
import { isCliProviderId } from "./llmCliRouting.js";

export const SUBSCRIPTION_MODE_ID = "subscription";
/** window event: ask the settings modal to switch section (detail = section id). */
export const OPEN_SETTINGS_SECTION_EVENT = "edgeassistant:open-settings-section";

/** The Subscription card is offered only for scopes the CLI allowlist covers. */
export function isSubscriptionModeOffered(scope) {
  return CLI_SCOPE_ALLOWLIST.includes(scope);
}

/** The hosted-cloud card is a dead option when the fork has no cloud backend configured. */
export function isCloudModeOffered(cloudEnabled) {
  return Boolean(cloudEnabled);
}

/**
 * Card shown as active. A CLI provider id under "providers" belongs to Subscription, not BYOK;
 * `subscriptionPending` covers a Subscription pick made before any seat was chosen.
 */
export function deriveDisplayMode(effectiveMode, provider, subscriptionPending = false) {
  if (effectiveMode === "providers" && (isCliProviderId(provider) || subscriptionPending)) {
    return SUBSCRIPTION_MODE_ID;
  }
  return effectiveMode;
}

/** Config patch for picking the Subscription card: first signed-in seat, else just the providers mode. */
export function subscriptionSelectPatch(firstSeat) {
  return firstSeat
    ? { mode: "providers", cloudMode: "byok", provider: firstSeat.id, model: "default" }
    : { mode: "providers", cloudMode: "byok", provider: "", model: "" };
}
