import { createContext, useContext } from "react";

/** What a skill card can do in the surface that shows it; the voice panel provides none. */
export interface SkillChatActions {
  openSkill?: (name: string) => void;
}

export const SkillChatActionsContext = createContext<SkillChatActions>({});

export function useSkillChatActions(): SkillChatActions {
  return useContext(SkillChatActionsContext);
}
