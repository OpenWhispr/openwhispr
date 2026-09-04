// i18n keys, not display strings: the panel resolves each through t() so the
// rotating verbs localize like every other UI string.
export const AGENT_TOOL_ACTIVITY_VERB_KEYS = Object.freeze([
  "assistant.toolActivity.verbs.invoking",
  "assistant.toolActivity.verbs.calling",
  "assistant.toolActivity.verbs.using",
]);
export const AGENT_TOOL_NAME_FALLBACK_KEY = "assistant.toolActivity.toolFallback";
export const AGENT_TOOL_ACTIVITY_ROTATION_MS = 1400;
// Fast local tools can finish before the native panel completes its entrance.
// Keep their presentation around long enough to survive that transition and
// show at least one deliberate verb handoff.
export const AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS = 2400;

export function getAgentToolActivityRemainingMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS - (now - startedAt));
}
