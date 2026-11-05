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

// A create whose answer never arrived can still have happened. Further than this from the attempt,
// a same-name space of the caller's is far more likely an earlier teamspace than the one it made.
const LOST_CREATE_WINDOW_MS = 5 * 60_000;
// How long a retry may still be the same attempt, while the connection comes back.
const UNSETTLED_CREATE_TTL_MS = 60 * 60_000;

export interface SpaceDeleteResult {
  success: boolean;
  error?: string;
  failure?: SpaceActionError;
  /** Notes that hadn't synced, which moved to Personal rather than go with the teamspace. */
  relocatedCount?: number;
}

/** A delete waiting out its Undo window: the teamspace is out of view and otherwise untouched. */
export interface SpaceDeleteHold {
  /** Brings the teamspace back as it was. False once the delete has gone ahead. */
  undo: () => Promise<boolean>;
  /** Sends the delete. Null when there's nothing to report: it was undone, or the account changed. */
  commit: () => Promise<SpaceDeleteResult | null>;
  /** Holds it again for a retry, or null when the account that asked has gone. */
  again: () => SpaceDeleteHold | null;
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
      input: CreateSpaceInput & { member_ids: string[]; team_ids: string[] }
    ) => Promise<MySpace>;
    update: (spaceId: string, updates: SpaceUpdatePatch) => Promise<SpaceRecord>;
    remove: (spaceId: string) => Promise<void>;
    assignTeam: (spaceId: string, teamId: string, access?: "admin" | "member") => Promise<void>;
    unassignTeam: (spaceId: string, teamId: string) => Promise<void>;
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
    purgeSpace: (id: number) => Promise<MutationResult & { relocatedCount?: number }>;
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
  deleteHold: {
    /** Moves only when another account signs in, unlike the session's token. */
    accountGeneration: () => number;
    /** The result brings the teamspace back into view; true also returns to where the user was. */
    hide: (space: SpaceItem, cloudSpaceId: string) => (reopen: boolean) => Promise<void>;
    release: (space: SpaceItem, cloudSpaceId: string) => void;
    markDeleted: (space: SpaceItem) => void;
  };
}

function requireCloudSpaceId(space: SpaceItem): string {
  if (!space.cloud_space_id) throw new Error("Not a cloud space");
  return space.cloud_space_id;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

// No usable response: the request may have been carried out before the answer was lost, which a
// gateway's 5xx can't rule out either. A status 0 with a code is main refusing the request itself
// (a changed session), which never went out.
function isLostAnswer(err: unknown): boolean {
  return err instanceof CloudApiError && !err.code && (!err.status || err.status >= 500);
}

export function createSpaceActions(deps: SpaceActionsDependencies) {
  const openHolds = new Set<SpaceDeleteHold>();

  // Creates whose answer was lost and which the follow-up read couldn't settle, by when they were
  // tried. A dropped connection usually takes that read down too, so the retry settles it instead.
  const unsettledCreates = new Map<string, number>();
  const normalizedName = (name: string): string => name.trim().toLowerCase();
  const createKey = (workspaceId: string, name: string): string =>
    `${workspaceId}\0${normalizedName(name)}`;

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

  // After a write the server accepted. A failed refresh doesn't make that write a failure, so the
  // sync pass catches the mirror up instead.
  async function refreshMirrorAfterWrite(): Promise<void> {
    try {
      await refreshSpaceMirror();
    } catch (err) {
      console.error("Space mirror refresh failed after a write:", err);
      deps.sync.requestSyncAll("manual");
    }
  }

  // After a lost answer the server may still have created the teamspace. It is the caller's own
  // when it is in this workspace under the name sent, the caller is its direct admin (the creator
  // always is) and it is new; any other same-name space was there before this attempt.
  async function findLostCreate(
    workspaceId: string,
    name: string,
    triedAt: number
  ): Promise<MySpace | null | undefined> {
    const wanted = normalizedName(name);
    try {
      const cloudSpaces = await deps.spaces.mySpaces();
      return (
        cloudSpaces.find(
          (cloudSpace) =>
            cloudSpace.workspace_id === workspaceId &&
            normalizedName(cloudSpace.name) === wanted &&
            cloudSpace.my_direct_role === "admin" &&
            // Either side of the attempt: this clock and the server's can disagree.
            Math.abs(triedAt - Date.parse(cloudSpace.created_at)) <= LOST_CREATE_WINDOW_MS
        ) ?? null
      );
    } catch {
      // Undefined: the read failed, so the create is still unsettled. Its own error is reported.
      return undefined;
    }
  }

  // Members and teams travel in the create body, so the server grants them
  // atomically with the space; there is no partial-failure state to report.
  async function createSpace(
    workspaceId: string,
    input: CreateSpaceInput,
    access: { memberIds: string[]; teamIds: string[] }
  ): Promise<SpaceItem | null> {
    const key = createKey(workspaceId, input.name);
    const triedAt = Date.now();
    let cloudSpace: MySpace;
    try {
      cloudSpace = await deps.spaces.create(workspaceId, {
        ...input,
        member_ids: access.memberIds,
        team_ids: access.teamIds,
      });
    } catch (err) {
      const lastTry = unsettledCreates.get(key);
      const unsettledAt =
        lastTry !== undefined && triedAt - lastTry <= UNSETTLED_CREATE_TTL_MS ? lastTry : undefined;
      // The name is taken by this user's own lost create, if an earlier try is still unsettled.
      const mayBeOurs =
        isLostAnswer(err) ||
        (unsettledAt !== undefined && classifySpaceError(err).kind === "nameTaken");
      if (!mayBeOurs) {
        unsettledCreates.delete(key);
        throw err;
      }
      const created = await findLostCreate(workspaceId, input.name, unsettledAt ?? triedAt);
      if (created === undefined) unsettledCreates.set(key, unsettledAt ?? triedAt);
      else unsettledCreates.delete(key);
      if (!created) throw err;
      cloudSpace = created;
    }
    unsettledCreates.delete(key);
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
    updates: { name: string; emoji: string | null; description?: string | null }
  ): Promise<{ success: boolean; error?: string; failure?: SpaceActionError }> {
    // The mirror has no description column, so the local row only ever gets the name and emoji.
    const local = await deps.local.updateSpaceMeta(space.id, {
      name: updates.name,
      emoji: updates.emoji,
    });
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
      return { success: false, error: errorMessage(err), failure: classifySpaceError(err) };
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

  async function deleteSpace(space: SpaceItem): Promise<SpaceDeleteResult> {
    if (space.cloud_space_id) {
      try {
        await deps.spaces.remove(space.cloud_space_id);
      } catch (err) {
        const failure = classifySpaceError(err);
        // An archived or missing space is gone: an earlier delete went through and its answer was
        // lost, or someone else deleted it first. Either way the mirror still lists it.
        if (failure.kind !== "archived" && failure.kind !== "gone") {
          return { success: false, error: errorMessage(err), failure };
        }
      }
      deps.invalidateSpaceRoster(space.cloud_space_id);
      await deps.markSpacePurged(space.cloud_space_id, "deleted");
    }
    const purged = await deps.local.purgeSpace(space.id);
    if (!purged.success) {
      // A sync pass that saw the space gone may have purged it first.
      const spaces = await deps.local.getSpaces();
      return spaces.some((candidate) => candidate.id === space.id) ? purged : { success: true };
    }
    return purged;
  }

  // Nothing is sent or removed until the Undo window ends: the purge can't be taken back (it scrubs
  // note chats, and unsynced notes fork into Personal), and every member's next sync pass runs the
  // same purge once the server says the teamspace is gone. Until then only this view changes.
  function holdSpaceDelete(space: SpaceItem): SpaceDeleteHold {
    return holdForAccount(space, deps.deleteHold.accountGeneration());
  }

  // The toast that ends the window goes with the page, and it told the user this was deleted.
  // Best effort: a request the app quits before sending leaves the teamspace as it was.
  function commitHeldDeletes(): void {
    for (const hold of openHolds) void hold.commit();
  }

  function holdForAccount(space: SpaceItem, accountGeneration: number): SpaceDeleteHold {
    const cloudSpaceId = requireCloudSpaceId(space);
    const accountChanged = (): boolean => deps.deleteHold.accountGeneration() !== accountGeneration;
    const bringBack = deps.deleteHold.hide(space, cloudSpaceId);
    const bringBackSafely = async (reopen: boolean): Promise<void> => {
      try {
        await bringBack(reopen);
      } catch (err) {
        // The next load shows it anyway, and the outcome still has to reach the user.
        console.error("Space could not be brought back into view:", err);
      }
    };
    let settled = false;
    const hold: SpaceDeleteHold = {
      async undo() {
        if (settled) return false;
        settled = true;
        openHolds.delete(hold);
        deps.deleteHold.release(space, cloudSpaceId);
        // Someone else's delete may have reached this device meanwhile, so nothing is back.
        const spaces = await deps.local.getSpaces().catch(() => [space]);
        if (!spaces.some((candidate) => candidate.id === space.id)) return false;
        await bringBackSafely(true);
        return true;
      },
      async commit() {
        if (settled) return null;
        settled = true;
        openHolds.delete(hold);
        // The account reset has dropped the hold and everything it hid. This one's delete must not
        // go out as the next account.
        if (accountChanged()) return null;
        let result: SpaceDeleteResult;
        try {
          result = await deleteSpace(space);
        } catch (err) {
          result = { success: false, error: errorMessage(err), failure: { kind: "failed" } };
        }
        if (result.success) {
          deps.deleteHold.markDeleted(space);
        } else {
          deps.deleteHold.release(space, cloudSpaceId);
          await bringBackSafely(false);
        }
        return result;
      },
      again: () => (accountChanged() ? null : holdForAccount(space, accountGeneration)),
    };
    openHolds.add(hold);
    return hold;
  }

  async function assignTeamToSpace(space: SpaceItem, teamId: string): Promise<void> {
    await deps.spaces.assignTeam(requireCloudSpaceId(space), teamId);
    await refreshMirrorAfterWrite();
  }

  async function setSpaceTeamAccess(
    space: SpaceItem,
    teamId: string,
    access: "admin" | "member"
  ): Promise<void> {
    await deps.spaces.assignTeam(requireCloudSpaceId(space), teamId, access);
    await refreshMirrorAfterWrite();
  }

  async function unassignTeamFromSpace(space: SpaceItem, teamId: string): Promise<void> {
    await deps.spaces.unassignTeam(requireCloudSpaceId(space), teamId);
    await refreshMirrorAfterWrite();
    deps.sync.requestSyncAll("manual");
  }

  // A newly reachable space inserts as pending in the mirror; the sync pass backfills its content.
  async function joinSpace(cloudSpaceId: string): Promise<{ joined: boolean }> {
    const result = await deps.spaces.join(cloudSpaceId);
    // Joined or already in, the server says the caller belongs. A space they left within the guard's
    // TTL is skipped by the refresh, so the guard is released on this answer; the refresh itself
    // must not release from its own listing, which can be stale.
    await deps.releasePurgedSpace(cloudSpaceId);
    await refreshMirrorAfterWrite();
    deps.sync.requestSyncAll("manual");
    return result;
  }

  // The server leaves people already in the space as they are, so a retry only reports them.
  async function addPeopleToSpace(
    cloudSpaceId: string,
    userIds: string[]
  ): Promise<{ added: string[]; already_members: string[] }> {
    const result = await deps.spaces.addMembers(cloudSpaceId, userIds);
    await refreshMirrorAfterWrite();
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
    await refreshMirrorAfterWrite();
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
    await refreshMirrorAfterWrite();
  }

  async function removeSpaceMember(space: SpaceItem, userId: string): Promise<SpaceMemberRemoval> {
    const result = await deps.spaces.removeMember(requireCloudSpaceId(space), userId);
    await refreshMirrorAfterWrite();
    return result;
  }

  // Dropping one's own direct grant can revoke container access, so the
  // sync pass runs to purge content the mirror no longer lists.
  async function leaveSpace(space: SpaceItem, userId: string): Promise<SpaceMemberRemoval> {
    const spaceId = requireCloudSpaceId(space);
    let result: SpaceMemberRemoval;
    try {
      result = await deps.spaces.removeMember(spaceId, userId);
    } catch (err) {
      // Already out, or the space is gone: an earlier leave went through and its answer was lost,
      // or someone else got there first. Nothing is left to remove, but the mirror still lists it.
      if (classifySpaceError(err).kind !== "gone") throw err;
      result = { removed: false, still_via_teams: [] };
    }
    await refreshMirrorAfterWrite();
    deps.sync.requestSyncAll("manual");
    return result;
  }

  // A write found a space gone, which the mirror doesn't know yet. The sync pass drops what it no
  // longer lists and says what became of any notes that hadn't synced.
  function requestSpacesResync(): void {
    deps.sync.requestSyncAll("manual");
  }

  async function addTeamMembers(
    teamId: string,
    userIds: string[]
  ): Promise<{ failures: unknown[] }> {
    const failures = await settleAddMembers(userIds, (userId) =>
      deps.teams.addMember(teamId, userId)
    );
    await refreshMirrorAfterWrite();
    return { failures };
  }

  async function removeTeamMember(teamId: string, userId: string): Promise<void> {
    await deps.teams.removeMember(teamId, userId);
    await refreshMirrorAfterWrite();
  }

  async function setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await deps.teams.addMember(teamId, userId, role);
    await refreshMirrorAfterWrite();
  }

  async function leaveTeam(teamId: string, userId: string): Promise<void> {
    try {
      await deps.teams.removeMember(teamId, userId);
    } catch (err) {
      // Already out of the group, as after a leave that got partway: the mirror is what's left.
      if (classifySpaceError(err).kind !== "gone") throw err;
    }
    await refreshMirrorAfterWrite();
    deps.sync.requestSyncAll("manual");
  }

  async function deleteTeam(teamId: string): Promise<void> {
    await deps.teams.remove(teamId);
    await refreshMirrorAfterWrite();
    deps.sync.requestSyncAll("manual");
  }

  return {
    createSpace,
    renameSpace,
    deleteSpace,
    holdSpaceDelete,
    commitHeldDeletes,
    assignTeamToSpace,
    setSpaceTeamAccess,
    unassignTeamFromSpace,
    joinSpace,
    addPeopleToSpace,
    setSpaceAccessFlags,
    localSpaceIdFor,
    setSpaceMemberRole,
    removeSpaceMember,
    leaveSpace,
    requestSpacesResync,
    addTeamMembers,
    removeTeamMember,
    setTeamMemberRole,
    leaveTeam,
    deleteTeam,
  };
}
