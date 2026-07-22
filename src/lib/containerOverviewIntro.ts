type IntroStorage = Pick<Storage, "getItem" | "setItem">;

export const CONTAINER_OVERVIEW_INTRO_VERSION = 1;
export const CONTAINER_OVERVIEW_INTRO_STORAGE_KEY = "containerOverviewIntroVersion";

export function shouldShowContainerOverviewIntro(
  storage: IntroStorage,
  version: number = CONTAINER_OVERVIEW_INTRO_VERSION
): boolean {
  const seenVersion = Number(storage.getItem(CONTAINER_OVERVIEW_INTRO_STORAGE_KEY));
  return !Number.isFinite(seenVersion) || seenVersion < version;
}

export function markContainerOverviewIntroSeen(
  storage: IntroStorage,
  version: number = CONTAINER_OVERVIEW_INTRO_VERSION
): void {
  storage.setItem(CONTAINER_OVERVIEW_INTRO_STORAGE_KEY, String(version));
}
