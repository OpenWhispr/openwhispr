import { classifySpaceError, type SpaceActionError } from "../lib/workspaceErrors";
import type { SpaceItem, TeamRole } from "../types/electron";
import { CloudApiError } from "./cloudApi";
import type { MySpace, SpaceMemberRemoval, SpaceRecord, SpacesService } from "./SpacesService";

interface MutationResult {
  success: boolean;
  error?: string;
}

type SpaceUpdatePatch = Parameters<typeof SpacesService.update>[1];

export interface CreateSpaceInput {
  name: string;
  emoji?: string | null;
  description?: string;
  is_default?: boolean;
  is_open?: boolean;
}

// A create whose answer never arrived can still have happened. Past this age a same-name space
// of the caller's is far more likely an earlier teamspace than the one this attempt made.
const LOST_CREATE_WINDOW_MS = 5 * 60_000;

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
      input: CreateSpaceInput & { member_ids: string[]; team_ids: string[] }
    ) => Promise<MySpace>;
    update: (spaceId: string, updates: SpaceUpdatePatch) => Promise<SpaceRecord>;
    remove: (spaceId: string) => Promise<void>;
    assignTeam: (spaceId: string, teamId: string, access?: "admin" | "member") => Promise<void>;
    unassignTeam: (spaceId: string, teamId: string) => Promise<void>;
    addMember: (spaceId: string, userId: string, role?: TeamRole) => Promise<void>;
    setMemberRole: (spaceId: string, userId: string, role: TeamRole) => Promise<void>;
    removeMember: (spaceId: string, userId: string) => Promise<SpaceMemberRemoval>;
    join: (spaceId: string) => Promise<{ joined: boolean }>;
    addMembers: (
      spaceId: string,
      userIds: string[]
    ) => Promise<{ added: string[]; already_members: string[] }>;
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
    getSpaces: () => Promise<SpaceItem[]>;
  };
  mirror: {
    upsertCloudSpaces: (spaces: MySpace[]) => Promise<unknown>;
  };
  sync: {
    requestSyncAll: (reason: string) => void;
  };
  markSpacePurged: (cloudSpaceId: string, reason: "deleted") => Promise<void>;
  releasePurgedSpace: (cloudSpaceId: string) => Promise<void>;
  invalidateSpaceRoster: (cloudSpaceId?: string) => void;
}

function requireCloudSpaceId(space: SpaceItem): string {
  if (!space.cloud_space_id) throw new Error("Not a cloud space");
  return space.cloud_space_id;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

// No response at all: the request may have been carried out before the answer was lost. A status
// 0 with a code is main refusing the request itself (a changed session), which never went out.
function isLostAnswer(err: unknown): boolean {
  return err instanceof CloudApiError && !err.status && !err.code;
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

  // After a lost answer the server may still have created the teamspace. It is the caller's own
  // when it is in this workspace under the name sent, the caller is its direct admin (the creator
  // always is) and it is new; any other same-name space was there before this attempt.
  async function findLostCreate(workspaceId: string, name: string): Promise<MySpace | null> {
    const wanted = name.trim();
    try {
      const cloudSpaces = await deps.spaces.mySpaces();
      const now = Date.now();
      return (
        cloudSpaces.find(
          (cloudSpace) =>
            cloudSpace.workspace_id === workspaceId &&
            cloudSpace.name.trim() === wanted &&
            cloudSpace.my_direct_role === "admin" &&
            // Either side of now: this clock and the server's can disagree.
            Math.abs(now - Date.parse(cloudSpace.created_at)) <= LOST_CREATE_WINDOW_MS
        ) ?? null
      );
    } catch {
      // The create's own error is the one worth reporting.
      return null;
    }
  }

  // Members and teams travel in the create body, so the server grants them
  // atomically with the space; there is no partial-failure state to report.
  async function createSpace(
    workspaceId: string,
    input: CreateSpaceInput,
    access: { memberIds: string[]; teamIds: string[] }
  ): Promise<SpaceItem | null> {
    let cloudSpace: MySpace;
    try {
      cloudSpace = await deps.spaces.create(workspaceId, {
        ...input,
        member_ids: access.memberIds,
        team_ids: access.teamIds,
      });
    } catch (err) {
      // A retry of a create that went through would only meet its own name taken.
      const created = isLostAnswer(err) ? await findLostCreate(workspaceId, input.name) : null;
      if (!created) throw err;
      cloudSpace = created;
    }
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

    let cloudSpace: SpaceRecord;
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
      // The response carries no access fields, and the upsert overwrites them all, so the
      // caller's roles, teams and capabilities carry over from the mirror until the next sync.
      await deps.local.upsertSpaceFromCloud({
        my_role: space.my_role,
        my_direct_role: space.my_direct_role,
        member_count: space.member_count,
        teams: space.teams,
        capabilities: space.capabilities,
        ...cloudSpace,
      });
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

  async function deleteSpace(
    space: SpaceItem
  ): Promise<{ success: boolean; error?: string; failure?: SpaceActionError }> {
    if (space.cloud_space_id) {
      try {
        await deps.spaces.remove(space.cloud_space_id);
      } catch (err) {
        const failure = classifySpaceError(err);
        // An archived space is gone: an earlier delete went through and its answer was lost.
        if (failure.kind !== "archived") {
          return { success: false, error: errorMessage(err), failure };
        }
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

  // A newly reachable space inserts as pending in the mirror; the sync pass backfills its content.
  async function joinSpace(cloudSpaceId: string): Promise<{ joined: boolean }> {
    const result = await deps.spaces.join(cloudSpaceId);
    // Joined or already in, the server says the caller belongs. A space they left within the guard's
    // TTL is skipped by the refresh, so the guard is released on this answer; the refresh itself
    // must not release from its own listing, which can be stale.
    await deps.releasePurgedSpace(cloudSpaceId);
    await refreshSpaceMirror();
    deps.sync.requestSyncAll("manual");
    return result;
  }

  // The server leaves people already in the space as they are, so a retry only reports them.
  async function addPeopleToSpace(
    cloudSpaceId: string,
    userIds: string[]
  ): Promise<{ added: string[]; already_members: string[] }> {
    const result = await deps.spaces.addMembers(cloudSpaceId, userIds);
    await refreshSpaceMirror();
    deps.sync.requestSyncAll("manual");
    return result;
  }

  // The flags aren't mirrored (the pages read them from the directory); the refresh follows like
  // every other space change, so the mirror never trails the server.
  async function setSpaceAccessFlags(
    cloudSpaceId: string,
    flags: { is_default?: boolean; is_open?: boolean }
  ): Promise<void> {
    await deps.spaces.update(cloudSpaceId, flags);
    await refreshSpaceMirror();
  }

  // A space reached through a join or an add is mirrored by then; a miss means the mirror is stale.
  async function localSpaceIdFor(cloudSpaceId: string): Promise<number | null> {
    const findLocalId = async (): Promise<number | null> => {
      const spaces = await deps.local.getSpaces();
      return spaces.find((space) => space.cloud_space_id === cloudSpaceId)?.id ?? null;
    };
    const known = await findLocalId();
    if (known != null) return known;
    await refreshSpaceMirror();
    return findLocalId();
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
    joinSpace,
    addPeopleToSpace,
    setSpaceAccessFlags,
    localSpaceIdFor,
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
