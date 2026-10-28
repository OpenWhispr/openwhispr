import { markIntroSeen, shouldShowIntro, type VersionedIntro } from "./versionedIntro.ts";
import type { WorkspaceSwitcherState } from "./workspaceSwitcher.ts";

type IntroStorage = Pick<Storage, "getItem" | "setItem">;

export const WORKSPACE_INTRO_VERSION = 1;

/** Seen per device, account and workspace: not synced, so a new device shows it once more. */
export function workspaceIntroKey(accountId: string, workspaceId: string): string {
  return `workspaceIntroVersion:${accountId}:${workspaceId}`;
}

function workspaceIntro(accountId: string, workspaceId: string): VersionedIntro {
  return {
    storageKey: workspaceIntroKey(accountId, workspaceId),
    version: WORKSPACE_INTRO_VERSION,
  };
}

export function shouldShowWorkspaceIntro({
  storage,
  accountId,
  switcher,
  blocked,
}: {
  storage: IntroStorage;
  accountId: string | null;
  switcher: WorkspaceSwitcherState;
  /** Another modal owns the screen: Settings, or the create → invite chain. */
  blocked: boolean;
}): boolean {
  if (blocked || !accountId || switcher.kind !== "workspace") return false;
  try {
    return shouldShowIntro(storage, workspaceIntro(accountId, switcher.current.id));
  } catch {
    // Storage we can't read can't remember a dismissal either, so showing it would repeat forever.
    return false;
  }
}

export function markWorkspaceIntroSeen(
  storage: IntroStorage,
  accountId: string,
  workspaceId: string
): void {
  try {
    markIntroSeen(storage, workspaceIntro(accountId, workspaceId));
  } catch {
    // The intro is closed either way; it only can't be remembered.
  }
}
