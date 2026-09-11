export const USE_CASE_IDS = {
  dictation: "dictation",
  meetings: "meetings",
  healthcare: "healthcare",
  translation: "translation",
  ai: "ai",
  upload: "upload",
} as const;

export type UseCaseId = (typeof USE_CASE_IDS)[keyof typeof USE_CASE_IDS];

export interface UseCaseOption {
  id: UseCaseId;
}

export const USE_CASE_OPTIONS: UseCaseOption[] = [
  { id: USE_CASE_IDS.dictation },
  { id: USE_CASE_IDS.meetings },
  { id: USE_CASE_IDS.healthcare },
  { id: USE_CASE_IDS.translation },
  { id: USE_CASE_IDS.upload },
  { id: USE_CASE_IDS.ai },
];

export const hasUseCaseIntent = (useCases: string[], note: string) =>
  useCases.length > 0 || note.trim().length > 0;
