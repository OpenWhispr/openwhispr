type IntroStorage = Pick<Storage, "getItem" | "setItem">;

export const NOTES_STRUCTURE_INTRO_VERSION = 1;
export const NOTES_STRUCTURE_INTRO_STORAGE_KEY = "notesStructureIntroVersion";

export function shouldShowNotesStructureIntro(
  storage: IntroStorage,
  version: number = NOTES_STRUCTURE_INTRO_VERSION
): boolean {
  const seenVersion = Number(storage.getItem(NOTES_STRUCTURE_INTRO_STORAGE_KEY));
  return !Number.isFinite(seenVersion) || seenVersion < version;
}

export function markNotesStructureIntroSeen(
  storage: IntroStorage,
  version: number = NOTES_STRUCTURE_INTRO_VERSION
): void {
  storage.setItem(NOTES_STRUCTURE_INTRO_STORAGE_KEY, String(version));
}
