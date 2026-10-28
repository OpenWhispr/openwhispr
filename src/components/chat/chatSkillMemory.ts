import type { SkillRef } from "../../types/skills";

export interface AttachedSkill {
  ref: SkillRef;
  displayName: string;
  /** Picked by the app for a model without tools, rather than attached by the user. */
  picked?: boolean;
}

/** What a conversation keeps about its skills while the user is in another chat. */
export interface ChatSkills {
  attached: AttachedSkill | null;
  /** The user removed a skill the app picked; no other is picked in this chat. */
  pickOff: boolean;
  /** Skills the user took off this chat, which stay off it even where the model loaded them. */
  removed: string[];
}

export const NO_CHAT_SKILLS: ChatSkills = { attached: null, pickOff: false, removed: [] };

// Kept on this computer only: a conversation synced from elsewhere starts without them.
const storageKey = (conversationId: number): string => `chatSkills:${conversationId}`;

const isAttached = (value: unknown): value is AttachedSkill => {
  const skill = value as AttachedSkill | null;
  return (
    typeof skill?.displayName === "string" &&
    typeof skill.ref?.name === "string" &&
    (skill.ref.builtin === undefined || typeof skill.ref.builtin === "boolean") &&
    (skill.picked === undefined || typeof skill.picked === "boolean")
  );
};

export function readChatSkills(conversationId: number): ChatSkills {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey(conversationId)) ?? "null");
    if (!stored) return NO_CHAT_SKILLS;
    return {
      attached: isAttached(stored.attached) ? stored.attached : null,
      pickOff: stored.pickOff === true,
      removed: Array.isArray(stored.removed)
        ? stored.removed.filter((name: unknown): name is string => typeof name === "string")
        : [],
    };
  } catch {
    return NO_CHAT_SKILLS;
  }
}

export function writeChatSkills(conversationId: number, skills: ChatSkills): void {
  try {
    const empty = !skills.attached && !skills.pickOff && skills.removed.length === 0;
    if (empty) localStorage.removeItem(storageKey(conversationId));
    else localStorage.setItem(storageKey(conversationId), JSON.stringify(skills));
  } catch {
    // The chat keeps its skills until the user leaves it.
  }
}

export function forgetChatSkills(conversationId: number): void {
  try {
    localStorage.removeItem(storageKey(conversationId));
  } catch {
    // Nothing reads a deleted conversation's entry.
  }
}
