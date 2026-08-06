import type { SpaceItem, TeamRole } from "../types/electron";
import type { MySpace } from "./SpacesService";

interface CloudTeam {
  id: string;
}

interface MutationResult {
  success: boolean;
  error?: string;
}

export interface SpaceActionsDependencies {
  teams: {
    create: (workspaceId: string, input: { name: string }) => Promise<CloudTeam>;
    remove: (teamId: string) => Promise<void>;
    addMember: (teamId: string, userId: string, role?: TeamRole) => Promise<void>;
    removeMember: (teamId: string, userId: string) => Promise<void>;
  };
  spaces: {
    mySpaces: () => Promise<MySpace[]>;
    create: (
      workspaceId: string,
      input: { name: string; emoji?: string | null; team_ids: string[] }
    ) => Promise<MySpace>;
    update: (spaceId: string, updates: { name: string; emoji: string | null }) => Promise<MySpace>;
    remove: (spaceId: string) => Promise<void>;
    assignTeam: (spaceId: string, teamId: string, access?: "admin" | "member") => Promise<void>;
    unassignTeam: (spaceId: string, teamId: string) => Promise<void>;
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
  async function settleAddMembers(teamId: string, userIds: string[]): Promise<unknown[]> {
    const results = await Promise.allSettled(
      userIds.map((userId) => deps.teams.addMember(teamId, userId))
    );
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

  async function createSpace(
    workspaceId: string,
    input: { name: string; emoji?: string | null },
    teams: { existingTeamIds: string[]; newTeam?: { name: string; memberIds: string[] } }
  ): Promise<{ space: SpaceItem | null; failedMembers: number }> {
    const teamIds = [...teams.existingTeamIds];
    let failedMembers = 0;
    let createdTeamId: string | null = null;
    if (teams.newTeam) {
      const team = await deps.teams.create(workspaceId, { name: teams.newTeam.name });
      createdTeamId = team.id;
      failedMembers = (await settleAddMembers(team.id, teams.newTeam.memberIds)).length;
      teamIds.push(team.id);
    }

    let cloudSpace: MySpace;
    try {
      cloudSpace = await deps.spaces.create(workspaceId, {
        name: input.name,
        emoji: input.emoji,
        team_ids: teamIds,
      });
    } catch (err) {
      if (createdTeamId) await deps.teams.remove(createdTeamId).catch(() => {});
      throw err;
    }

    const space = await deps.local.upsertSpaceFromCloud(
      cloudSpace as unknown as Record<string, unknown>
    );
    if (space) await deps.local.setSpaceSyncStatus(space.id, "synced");
    await deps.local.loadSpaces();
    deps.sync.requestSyncAll("manual");
    return { space, failedMembers };
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

  async function addTeamMembers(
    teamId: string,
    userIds: string[]
  ): Promise<{ failures: unknown[] }> {
    const failures = await settleAddMembers(teamId, userIds);
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
    addTeamMembers,
    removeTeamMember,
    setTeamMemberRole,
    leaveTeam,
    deleteTeam,
  };
}
