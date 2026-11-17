import { cloudGetForAuthGeneration, CloudApiError, isAuthContextError } from "./cloudApi.js";
import type { NoteAccessState } from "../types/electron";

const MAX_CONCURRENT_REQUESTS = 3;

type OwnershipApi = Pick<
  NonNullable<Window["electronAPI"]>,
  "getStandInOwnershipCandidates" | "resolveStandInOwnership"
>;

export interface StandInOwnershipOptions {
  accountId: string;
  authGeneration: number;
  isCurrent: () => boolean;
  api?: OwnershipApi;
  get?: typeof cloudGetForAuthGeneration;
}

export interface StandInOwnershipResult {
  claimed: number;
  notOwned: number;
}

/**
 * The cloud's answer for this account: true/false, or null when it did not
 * say. A teamspace note counts as not owned, since the owner's team sync
 * brings it in. An owned note scoped to a whole workspace (no teamspace) is
 * claimed: the notes pull files any note without a teamspace in Private.
 */
function ownershipFromAccess(access: NoteAccessState, accountId: string): boolean | null {
  switch (access?.my_permission) {
    case "owner":
      if (access.owner?.id !== accountId) return null;
      return !access.grants?.some((grant) => grant.source === "space");
    case "editor":
    case "viewer":
      return false;
    default:
      return null;
  }
}

async function askIfOwned(
  cloudId: string,
  accountId: string,
  authGeneration: number,
  get: typeof cloudGetForAuthGeneration
): Promise<boolean | null> {
  try {
    const access = await get<NoteAccessState>(
      `/api/notes/${encodeURIComponent(cloudId)}/access`,
      authGeneration
    );
    const owned = ownershipFromAccess(access, accountId);
    if (owned === null) {
      console.warn("A backed-up note's access answer named no owner it could use");
    }
    return owned;
  } catch (error) {
    if (isAuthContextError(error)) return null;
    // No relationship (404) or a grant short of editor (403 note_access_denied);
    // any other 403, such as SSO_REQUIRED, refuses even the owner.
    if (
      error instanceof CloudApiError &&
      (error.status === 404 || (error.status === 403 && error.code === "note_access_denied"))
    ) {
      return false;
    }
    console.warn("Could not check who owns a backed-up note:", error);
    return null;
  }
}

/**
 * Asks the cloud, once per account, who owns the ownerless notes this device
 * holds a cloud copy of, so each can move to its account or to "On this device".
 */
export async function checkStandInOwnership({
  accountId,
  authGeneration,
  isCurrent,
  api = window.electronAPI,
  get = cloudGetForAuthGeneration,
}: StandInOwnershipOptions): Promise<StandInOwnershipResult> {
  const result: StandInOwnershipResult = { claimed: 0, notOwned: 0 };
  const candidates = (await api?.getStandInOwnershipCandidates?.()) ?? [];
  const queue = [...candidates];

  const worker = async (): Promise<void> => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (!isCurrent()) return;
      try {
        const owned = await askIfOwned(next.cloud_id, accountId, authGeneration, get);
        if (owned === null || !isCurrent()) continue;
        const outcome = await api?.resolveStandInOwnership?.({
          noteId: next.id,
          cloudId: next.cloud_id,
          owned,
          accountId,
        });
        if (!outcome || "success" in outcome) continue;
        if (owned && outcome.claimed) result.claimed++;
        else if (!owned) result.notOwned++;
      } catch (error) {
        console.warn("Could not record who owns a backed-up note:", error);
      }
    }
  };

  await Promise.all(Array.from({ length: MAX_CONCURRENT_REQUESTS }, worker));
  return result;
}
