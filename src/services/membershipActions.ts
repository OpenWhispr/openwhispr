import { syncService } from "./SyncService";
import { useWorkspaceStore } from "../stores/workspaceStore";

/**
 * Everything that has to happen once an account gains workspace membership,
 * shared by the emailed-invitation flow and the post-signup join screen so
 * neither drifts from the other.
 */
export async function afterWorkspaceJoined(): Promise<void> {
  await useWorkspaceStore.getState().refresh();
  // Membership can change the caller's entitlement. Sync no longer depends on
  // it — collaboration is plan-independent — but the plan badge and word
  // limit still do.
  window.dispatchEvent(new Event("usage-changed"));
  // Pull the spaces this membership just unlocked; skeleton rows render while
  // their backfill is pending.
  syncService.requestSyncAll("manual");
}
