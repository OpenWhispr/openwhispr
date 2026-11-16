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

/** Whether the cloud answered for this account: true/false, or null when it did not say. */
async function askIfOwned(
  cloudId: string,
  authGeneration: number,
  get: typeof cloudGetForAuthGeneration
): Promise<boolean | null> {
  try {
    const access = await get<NoteAccessState>(
      `/api/notes/${encodeURIComponent(cloudId)}/access`,
      authGeneration
    );
    return access.my_permission === "owner";
  } catch (error) {
    if (isAuthContextError(error)) return null;
    // 404 and 403 both mean this account has no access to the note.
    if (error instanceof CloudApiError && (error.status === 404 || error.status === 403)) {
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
      const owned = await askIfOwned(next.cloud_id, authGeneration, get);
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
    }
  };

  await Promise.all(Array.from({ length: MAX_CONCURRENT_REQUESTS }, worker));
  return result;
}
