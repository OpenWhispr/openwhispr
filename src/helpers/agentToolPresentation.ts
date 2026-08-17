export const AGENT_TOOL_ACTIVITY_VERBS = Object.freeze(["Invoking", "Calling", "Using"]);
export const AGENT_TOOL_ACTIVITY_ROTATION_MS = 1400;
// Fast local tools can finish before the native panel completes its entrance.
// Keep their presentation around long enough to survive that transition and
// show at least one deliberate verb handoff.
export const AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS = 2400;

export function getAgentToolActivityRemainingMs(startedAt: number, now = Date.now()): number {
  return Math.max(0, AGENT_TOOL_ACTIVITY_MIN_VISIBLE_MS - (now - startedAt));
}

export function formatAgentToolName(name: string): string {
  const words = name
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());

  if (words.length === 0) return "Tool";
  words[0] = `${words[0][0].toUpperCase()}${words[0].slice(1)}`;
  return words.join(" ");
}
