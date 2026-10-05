type IntroStorage = Pick<Storage, "getItem" | "setItem">;

export interface VersionedIntro {
  storageKey: string;
  version: number;
}

export const CONTAINER_OVERVIEW_INTRO: VersionedIntro = {
  storageKey: "containerOverviewIntroVersion",
  version: 1,
};

export const NOTES_STRUCTURE_INTRO: VersionedIntro = {
  storageKey: "notesStructureIntroVersion",
  version: 1,
};

export function shouldShowIntro(
  storage: IntroStorage,
  intro: VersionedIntro,
  version: number = intro.version
): boolean {
  const seenVersion = Number(storage.getItem(intro.storageKey));
  return !Number.isFinite(seenVersion) || seenVersion < version;
}

export function markIntroSeen(
  storage: IntroStorage,
  intro: VersionedIntro,
  version: number = intro.version
): void {
  storage.setItem(intro.storageKey, String(version));
}
