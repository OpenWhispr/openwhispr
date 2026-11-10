import { classifyRemovalError } from "../lib/workspaceErrors";
import logger from "../utils/logger";
import type { MemberRemovalResult, WorkspaceMember } from "../types/electron";

export interface WorkspaceActionsDependencies {
  api: {
    removeMember(workspaceId: string, userId: string): Promise<void>;
    removeMembers(
      workspaceId: string,
      input: { userIds: string[]; transferTo?: string }
    ): Promise<MemberRemovalResult>;
    remove(workspaceId: string): Promise<void>;
    updateMemberRole(workspaceId: string, userId: string, role: "owner"): Promise<unknown>;
  };
  store: {
    forgetWorkspace(id: string): void;
    refresh(options: { fresh: true }): Promise<void>;
    refreshMembers(workspaceId: string): Promise<void>;
    /** Ids from the last refresh, or null when it failed. */
    listedWorkspaceIds(): string[] | null;
    /** The member's role in `workspaceId`'s last refreshed roster, or null when it isn't held. */
    memberRole(workspaceId: string, userId: string): WorkspaceMember["role"] | null;
  };
  /** Moves a lost workspace's Private into the default workspace's, on this device. */
  privateNotes: { relocateLostWorkspace(workspaceId: string): Promise<void> };
  sync: { requestSyncAll(reason: string): void };
  /** Tells the plan badge and word limit to re-read the entitlement. */
  notifyUsageChanged(): void;
}

export interface WorkspaceActions {
  leaveWorkspace(workspaceId: string, userId: string): Promise<void>;
  deleteWorkspace(workspaceId: string): Promise<void>;
  transferOwnership(workspaceId: string, newOwnerId: string): Promise<void>;
  removeMembers(
    workspaceId: string,
    input: { userIds: string[]; transferTo?: string }
  ): Promise<MemberRemovalResult>;
}

export function createWorkspaceActions(deps: WorkspaceActionsDependencies): WorkspaceActions {
  // The server change has already happened by the time a refresh runs, so a
  // refresh failure must not turn a successful action into a reported failure.
  async function refreshQuietly(label: string, refresh: () => Promise<void>): Promise<void> {
    try {
      await refresh();
    } catch (err) {
      logger.warn(
        `Workspace ${label} refresh failed after a successful change`,
        { error: err instanceof Error ? err.message : String(err) },
        "workspaces"
      );
    }
  }

  // A request whose answer was lost (a timeout, a dropped connection) may still have reached the
  // server, and a retry would then be refused. So a failure is checked against a fresh read
  // first, and counts as done when that read shows the change already happened.
  async function send(
    request: () => Promise<unknown>,
    alreadyDone: () => Promise<boolean>
  ): Promise<void> {
    try {
      await request();
    } catch (err) {
      if (await alreadyDone().catch(() => false)) return;
      throw err;
    }
  }

  async function noLongerListed(workspaceId: string): Promise<boolean> {
    await deps.store.refresh({ fresh: true });
    const ids = deps.store.listedWorkspaceIds();
    return ids !== null && !ids.includes(workspaceId);
  }

  // After the caller loses a workspace, `syncSpaces` purges the team spaces
  // that `/me/spaces` no longer lists, so the sync request cleans up the local mirror.
  // The store's refresh keeps its old list when it fails, so the lost workspace is
  // dropped first; otherwise it could still be picked as the current one. Its Private
  // moves to the default workspace's right away: forgetting it also drops it from the
  // list a later refresh would find it missing from.
  async function afterLosingWorkspace(workspaceId: string): Promise<void> {
    deps.store.forgetWorkspace(workspaceId);
    try {
      await deps.privateNotes.relocateLostWorkspace(workspaceId);
    } catch (err) {
      logger.warn(
        "Moving a lost workspace's private notes failed after a successful change",
        { error: err instanceof Error ? err.message : String(err) },
        "workspaces"
      );
    }
    await refreshQuietly("list", () => deps.store.refresh({ fresh: true }));
    // Losing a paid workspace can change the entitlement, as joining one can.
    deps.notifyUsageChanged();
    deps.sync.requestSyncAll("manual");
  }

  async function leaveWorkspace(workspaceId: string, userId: string): Promise<void> {
    await send(
      () => deps.api.removeMember(workspaceId, userId),
      () => noLongerListed(workspaceId)
    );
    await afterLosingWorkspace(workspaceId);
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    await send(
      () => deps.api.remove(workspaceId),
      () => noLongerListed(workspaceId)
    );
    await afterLosingWorkspace(workspaceId);
  }

  // The server demotes the previous owner in the same transaction, so the
  // caller's capabilities and the member roles both need a fresh read.
  async function transferOwnership(workspaceId: string, newOwnerId: string): Promise<void> {
    await send(
      () => deps.api.updateMemberRole(workspaceId, newOwnerId, "owner"),
      async () => {
        await deps.store.refreshMembers(workspaceId);
        return deps.store.memberRole(workspaceId, newOwnerId) === "owner";
      }
    );
    await refreshQuietly("list", () => deps.store.refresh({ fresh: true }));
    await refreshQuietly("members", () => deps.store.refreshMembers(workspaceId));
  }

  // Removals free seats, so the workspace list is read again too, and content moved to a new owner
  // reaches this device through a sync. That sync follows any run that named a new owner: a retry
  // after a lost answer reports no transfer although the first attempt moved the content.
  async function afterRemoval(workspaceId: string, transferTo: string | undefined): Promise<void> {
    await refreshQuietly("members", () => deps.store.refreshMembers(workspaceId));
    await refreshQuietly("list", () => deps.store.refresh({ fresh: true }));
    if (transferTo) deps.sync.requestSyncAll("manual");
  }

  async function removeMembers(
    workspaceId: string,
    input: { userIds: string[]; transferTo?: string }
  ): Promise<MemberRemovalResult> {
    let result: MemberRemovalResult;
    try {
      result = await deps.api.removeMembers(workspaceId, input);
    } catch (error) {
      // A refusal changed nothing, but with no answer the removal may still have gone through, so
      // what's listed is read again. Not awaited: the failure shows without waiting on the network
      // that just failed.
      if (classifyRemovalError(error).kind === "failed") {
        void afterRemoval(workspaceId, input.transferTo);
      }
      throw error;
    }
    await afterRemoval(workspaceId, input.transferTo);
    return result;
  }

  return { leaveWorkspace, deleteWorkspace, transferOwnership, removeMembers };
}
