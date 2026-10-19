// The agent window opens from the hotkey, the tray and the pill menu, and
// explains itself when the assistant can't run. A policy that never arrived
// (offline, or a failed fetch) fails closed exactly like a real restriction, so
// the refusal must not blame an org that restricted nothing. Keys resolve
// through i18n in the renderer.
export const AGENT_REFUSAL_KEYS = Object.freeze({
  agentRestricted: "common.policyAgentRestricted",
  policyUnresolved: "common.policyUnresolved",
});

/** Why the assistant can't open (an i18n key), or null when it can. */
export function resolveAgentAccessRefusal({ agentAllowed, policyResolved }) {
  if (agentAllowed) return null;
  return policyResolved ? AGENT_REFUSAL_KEYS.agentRestricted : AGENT_REFUSAL_KEYS.policyUnresolved;
}
