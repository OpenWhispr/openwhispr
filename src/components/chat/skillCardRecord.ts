import type { SkillCardRecord } from "../../types/skills";
import type { ToolCallInfo } from "./types";

/** The tools whose card stands in for their step. */
export const SKILL_CARD_TOOLS = new Set(["propose_skill", "update_skill"]);

const STATUSES = new Set<SkillCardRecord["status"]>([
  "saved",
  "skipped",
  "failed",
  "changed",
  "not_saved",
]);

/** A card's saved outcome, or null for a call that showed no card or a malformed record. */
export function readSkillCardRecord(call: ToolCallInfo): SkillCardRecord | null {
  if (!SKILL_CARD_TOOLS.has(call.name)) return null;
  const data = call.metadata;
  if (!data || Array.isArray(data)) return null;
  const { status, kind, name, title, versionId, message } = data;
  if (!STATUSES.has(status as SkillCardRecord["status"])) return null;
  if (kind !== "create" && kind !== "update") return null;
  if (typeof name !== "string" || !name || typeof title !== "string") return null;
  if (versionId !== undefined && typeof versionId !== "string") return null;
  return {
    status: status as SkillCardRecord["status"],
    kind,
    name,
    title,
    ...(typeof versionId === "string" && versionId ? { versionId } : {}),
    message: typeof message === "string" ? message : "",
  };
}

/**
 * A skill card call's arguments are the whole proposed skill (instructions and files), and
 * the chat is saved and synced. The skill's folder is its only copy, so the saved call keeps
 * none of them; its outcome record says what came of it.
 */
export function withoutSkillCardDrafts(toolCalls: ToolCallInfo[]): ToolCallInfo[] {
  return toolCalls.map((call) =>
    SKILL_CARD_TOOLS.has(call.name) ? { ...call, arguments: "{}" } : call
  );
}
