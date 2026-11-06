// Which transfers onboarding's local setup started, so the background tray can
// leave them alone. A released key stays claimed briefly: progress events already
// in flight when a download stops, or is cancelled, still arrive afterwards.
import type { LocalSetupDownload } from "../../config/localSetup";
import { localSetupItemKey } from "./localSetupDownloadState";

const RELEASE_GRACE_MS = 4000;
const claimedDownloads = new Map<string, number | null>();
let handOffRunning = false;

/** Proceed's queue is fetching the rows it took over, so the tray mustn't start them too. */
export async function runLocalSetupHandOff(run: () => Promise<void>): Promise<void> {
  handOffRunning = true;
  try {
    await run();
  } finally {
    handOffRunning = false;
  }
}

export function isLocalSetupHandOffRunning(): boolean {
  return handOffRunning;
}

export function claimLocalSetupDownload(item: Pick<LocalSetupDownload, "kind" | "id">): void {
  claimedDownloads.set(localSetupItemKey(item), null);
}

export function releaseLocalSetupDownload(
  item: Pick<LocalSetupDownload, "kind" | "id">,
  now = Date.now()
): void {
  claimedDownloads.set(localSetupItemKey(item), now);
}

/** Proceed gave the tray this transfer: its progress and any error show at once. */
export function handOverLocalSetupDownload(item: Pick<LocalSetupDownload, "kind" | "id">): void {
  claimedDownloads.delete(localSetupItemKey(item));
}

/** True while onboarding's local setup owns this transfer (kind as the tray keys it). */
export function isLocalSetupDownload(
  kind: LocalSetupDownload["kind"],
  id: string,
  now = Date.now()
): boolean {
  const key = localSetupItemKey({ kind, id });
  const releasedAt = claimedDownloads.get(key);
  if (releasedAt === undefined) return false;
  if (releasedAt === null || now - releasedAt < RELEASE_GRACE_MS) return true;
  claimedDownloads.delete(key);
  return false;
}
