import { Bot, Languages, LucideIcon, PenLine, Stethoscope, Users } from "lucide-react";

export const USE_CASE_IDS = {
  dictation: "dictation",
  meetings: "meetings",
  healthcare: "healthcare",
  translation: "translation",
  ai: "ai",
} as const;

export type UseCaseId = (typeof USE_CASE_IDS)[keyof typeof USE_CASE_IDS];

export interface UseCaseOption {
  id: UseCaseId;
  icon: LucideIcon;
}

export const USE_CASE_OPTIONS: UseCaseOption[] = [
  { id: USE_CASE_IDS.dictation, icon: PenLine },
  { id: USE_CASE_IDS.meetings, icon: Users },
  { id: USE_CASE_IDS.healthcare, icon: Stethoscope },
  { id: USE_CASE_IDS.translation, icon: Languages },
  { id: USE_CASE_IDS.ai, icon: Bot },
];
