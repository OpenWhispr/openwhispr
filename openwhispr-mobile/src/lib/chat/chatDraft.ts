/** Adds a spoken question to the composer after whatever is already typed there. */
export const withSpokenQuestion = (draft: string, spoken: string): string =>
  draft.trim() ? `${draft.trimEnd()} ${spoken}` : spoken;
