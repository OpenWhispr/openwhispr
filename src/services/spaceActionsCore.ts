import type { SpaceItem, TeamRole } from "../types/electron";
import type { MySpace, SpaceMemberRemoval } from "./SpacesService";

interface MutationResult {
  success: boolean;
  error?: string;
}

export interface SpaceActionsDependencies {
  teams: {
    remove: (teamId: string) => Promise<void>;
    addMember: (teamId: string, userId: string, role?: TeamRole) => Promise<void>;
    removeMember: (teamId: string, userId: string) => Promise<void>;
  };
  spaces: {
    mySpaces: () => Promise<MySpace[]>;
    create: (
      workspaceId: string,
      input: { name: string; emoji?: string | null; member_ids: string[]; team_ids: string[] }
    ) => Promise<MySpace>;
    update: (spaceId: string, updates: { name: string; emoji: string | null }) => Promise<MySpace>;
    remove: (spaceId: string) => Promise<void>;
    assignTeam: (spaceId: string, teamId: string, access?: "admin" | "member") => Promise<void>;
    unassignTeam: (spaceId: string, teamId: string) => Promise<void>;
    addMember: (spaceId: string, userId: string, role?: TeamRole) => Promise<void>;
    setMemberRole: (spaceId: string, userId: string, role: TeamRole) => Promise<void>;
    removeMember: (spaceId: string, userId: string) => Promise<SpaceMemberRemoval>;
  };
  local: {
    upsertSpaceFromCloud: (space: Record<string, unknown>) => Promise<SpaceItem | null>;
    setSpaceSyncStatus: (id: number, status: SpaceItem["sync_status"]) => Promise<void>;
    updateSpaceMeta: (
      id: number,
      updates: { name: string; emoji: string | null }
    ) => Promise<MutationResult>;
    purgeSpace: (id: number) => Promise<MutationResult>;
    loadSpaces: () => Promise<unknown>;
  };
  mirror: {
    upsertCloudSpaces: (spaces: MySpace[]) => Promise<unknown>;
  };
  sync: {
    requestSyncAll: (reason: string) => void;
  };
  markSpacePurged: (cloudSpaceId: string, reason: "deleted") => Promise<void>;
  invalidateSpaceRoster: (cloudSpaceId?: string) => void;
}

function requireCloudSpaceId(space: SpaceItem): string {
  if (!space.cloud_space_id) throw new Error("Not a cloud space");
  return space.cloud_space_id;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

export function createSpaceActions(deps: SpaceActionsDependencies) {
  // One failed add must not abort the rest; callers report the failures.
  async function settleAddMembers(
    userIds: string[],
    add: (userId: string) => Promise<void>
  ): Promise<unknown[]> {
    const results = await Promise.allSettled(userIds.map(add));
    return results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
  }

  async function refreshSpaceMirror(): Promise<void> {
    // Invalidate before fetching: a failed refresh must not preserve stale
    // member attribution in the roster cache.
    deps.invalidateSpaceRoster();
    const cloudSpaces = await deps.spaces.mySpaces();
    await deps.mirror.upsertCloudSpaces(cloudSpaces);
    await deps.local.loadSpaces();
  }

  // Members and teams travel in the create body, so the server grants them
  // atomically with the space; there is no partial-failure state to report.
  async function createSpace(
    workspaceId: string,
    input: { name: string; emoji?: string | null },
    access: { memberIds: string[]; teamIds: string[] }
  ): Promise<SpaceItem | null> {
    const cloudSpace = await deps.spaces.create(workspaceId, {
      name: input.name,
      emoji: input.emoji,
      member_ids: access.memberIds,
      team_ids: access.teamIds,
    });
    const space = await deps.local.upsertSpaceFromCloud(
      cloudSpace as unknown as Record<string, unknown>
    );
    if (space) await deps.local.setSpaceSyncStatus(space.id, "synced");
    await deps.local.loadSpaces();
    deps.sync.requestSyncAll("manual");
    return space;
  }

  async function renameSpace(
    space: SpaceItem,
    updates: { name: string; emoji: string | null }
  ): Promise<{ success: boolean; error?: string }> {
    const local = await deps.local.updateSpaceMeta(space.id, updates);
    if (!local.success) return local;
    if (!space.cloud_space_id) {
      await deps.local.setSpaceSyncStatus(space.id, "synced");
      await deps.local.loadSpaces();
      return { success: true };
    }

    let cloudSpace: MySpace;
    try {
      cloudSpace = await deps.spaces.update(space.cloud_space_id, updates);
    } catch (err) {
      await deps.local.updateSpaceMeta(space.id, {
        name: space.name,
        emoji: space.emoji ?? null,
      });
      await deps.local.setSpaceSyncStatus(space.id, "synced");
      await deps.local.loadSpaces();
      return { success: false, error: errorMessage(err) };
    }

    try {
      await deps.local.upsertSpaceFromCloud(cloudSpace as unknown as Record<string, unknown>);
      await deps.local.setSpaceSyncStatus(space.id, "synced");
      await deps.local.loadSpaces();
    } catch (err) {
      // The server won. Leave the optimistic row pending for the regular
      // mirror instead of rolling it back to a name that is now false.
      console.error("Space rename mirror failed:", err);
      deps.sync.requestSyncAll("manual");
    }
    return { success: true };
  }

  async function deleteSpace(space: SpaceItem): Promise<{ success: boolean; error?: string }> {
    if (space.cloud_space_id) {
      try {
        await deps.spaces.remove(space.cloud_space_id);
      } catch (err) {
        return { success: false, error: errorMessage(err) };
      }
      deps.invalidateSpaceRoster(space.cloud_space_id);
      await deps.markSpacePurged(space.cloud_space_id, "deleted");
    }
    return deps.local.purgeSpace(space.id);
  }

  async function assignTeamToSpace(space: SpaceItem, teamId: string): Promise<void> {
    await deps.spaces.assignTeam(requireCloudSpaceId(space), teamId);
    await refreshSpaceMirror();
  }

  async function setSpaceTeamAccess(
    space: SpaceItem,
    teamId: string,
    access: "admin" | "member"
  ): Promise<void> {
    await deps.spaces.assignTeam(requireCloudSpaceId(space), teamId, access);
    await refreshSpaceMirror();
  }

  async function unassignTeamFromSpace(space: SpaceItem, teamId: string): Promise<void> {
    await deps.spaces.unassignTeam(requireCloudSpaceId(space), teamId);
    await refreshSpaceMirror();
    deps.sync.requestSyncAll("manual");
  }

  async function addSpaceMembers(
    space: SpaceItem,
    userIds: string[]
  ): Promise<{ failures: unknown[] }> {
    const spaceId = requireCloudSpaceId(space);
    const failures = await settleAddMembers(userIds, (userId) =>
      deps.spaces.addMember(spaceId, userId)
    );
    await refreshSpaceMirror();
    return { failures };
  }

  async function setSpaceMemberRole(
    space: SpaceItem,
    userId: string,
    role: TeamRole
  ): Promise<void> {
    await deps.spaces.setMemberRole(requireCloudSpaceId(space), userId, role);
    await refreshSpaceMirror();
  }

  async function removeSpaceMember(space: SpaceItem, userId: string): Promise<SpaceMemberRemoval> {
    const result = await deps.spaces.removeMember(requireCloudSpaceId(space), userId);
    await refreshSpaceMirror();
    return result;
  }

  // Dropping one's own direct grant can revoke container access, so the
  // sync pass runs to purge content the mirror no longer lists.
  async function leaveSpace(space: SpaceItem, userId: string): Promise<SpaceMemberRemoval> {
    const result = await removeSpaceMember(space, userId);
    deps.sync.requestSyncAll("manual");
    return result;
  }

  async function addTeamMembers(
    teamId: string,
    userIds: string[]
  ): Promise<{ failures: unknown[] }> {
    const failures = await settleAddMembers(userIds, (userId) =>
      deps.teams.addMember(teamId, userId)
    );
    await refreshSpaceMirror();
    return { failures };
  }

  async function removeTeamMember(teamId: string, userId: string): Promise<void> {
    await deps.teams.removeMember(teamId, userId);
    await refreshSpaceMirror();
  }

  async function setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await deps.teams.addMember(teamId, userId, role);
    await refreshSpaceMirror();
  }

  async function leaveTeam(teamId: string, userId: string): Promise<void> {
    await deps.teams.removeMember(teamId, userId);
    await refreshSpaceMirror();
    deps.sync.requestSyncAll("manual");
  }

  async function deleteTeam(teamId: string): Promise<void> {
    await deps.teams.remove(teamId);
    await refreshSpaceMirror();
    deps.sync.requestSyncAll("manual");
  }

  return {
    createSpace,
    renameSpace,
    deleteSpace,
    assignTeamToSpace,
    setSpaceTeamAccess,
    unassignTeamFromSpace,
    addSpaceMembers,
    setSpaceMemberRole,
    removeSpaceMember,
    leaveSpace,
    addTeamMembers,
    removeTeamMember,
    setTeamMemberRole,
    leaveTeam,
    deleteTeam,
  };
}
