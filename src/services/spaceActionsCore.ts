import {
  classifySpaceError,
  classifyTeamError,
  type SpaceActionError,
  type TeamActionError,
} from "../lib/workspaceErrors";
import type { SpaceItem, Team, TeamRole } from "../types/electron";
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

export interface TeamDeleteResult {
  success: boolean;
  error?: string;
  failure?: TeamActionError;
}

/** A team delete waiting out its Undo window: the team is out of view and otherwise untouched. */
export interface TeamDeleteHold {
  /** Brings the team back as it was. False once the delete has gone ahead. */
  undo: () => Promise<boolean>;
  /** Sends the delete. Null when there's nothing to report: it was undone, or the account changed. */
  commit: () => Promise<TeamDeleteResult | null>;
  /** Holds it again for a retry, or null when the account that asked has gone. */
  again: () => TeamDeleteHold | null;
}

export interface SpaceActionsDependencies {
  teams: {
    list: (workspaceId: string) => Promise<Team[]>;
    create: (workspaceId: string, input: { name: string; member_ids: string[] }) => Promise<Team>;
    update: (teamId: string, updates: { name: string }) => Promise<Team>;
    addMembers: (
      teamId: string,
      userIds: string[]
    ) => Promise<{ added: string[]; already_members: string[] }>;
    remove: (teamId: string) => Promise<void>;
    setMemberRole: (teamId: string, userId: string, role: TeamRole) => Promise<void>;
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
  /** Reads the workspace's people again; the Team column lists each person's teams. */
  refreshWorkspaceRoster: (workspaceId: string) => Promise<void>;
  deleteHold: {
    /** Moves only when another account signs in, unlike the session's token. */
    accountGeneration: () => number;
    /** The result brings the teamspace back into view; true also returns to where the user was. */
    hide: (space: SpaceItem, cloudSpaceId: string) => (reopen: boolean) => Promise<void>;
    release: (space: SpaceItem, cloudSpaceId: string) => void;
    markDeleted: (space: SpaceItem) => void;
  };
  teamDeleteHold: {
    hide: (teamId: string) => void;
    release: (teamId: string) => void;
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
// gateway's 5xx can't rule out either, and main gives every 503 the code SERVER_ERROR. Any other
// code at status 0 is main refusing the request itself (a changed session), which never went out.
function isLostAnswer(err: unknown): boolean {
  return (
    err instanceof CloudApiError &&
    (!err.code || err.code === "SERVER_ERROR") &&
    (!err.status || err.status >= 500)
  );
}

export function createSpaceActions(deps: SpaceActionsDependencies) {
  const openHolds = new Set<{ commit: () => Promise<unknown> }>();

  // Creates whose answer was lost and which the follow-up read couldn't settle, by when they were
  // tried and what they asked for. A dropped connection usually takes that read down too, so the
  // retry settles it instead.
  const unsettledCreates = new Map<string, { triedAt: number; request: string }>();
  const normalizedName = (name: string): string => name.trim().toLowerCase();
  // A team and a teamspace may share a name, so one's create never settles the other's.
  const createKey = (kind: "space" | "team", workspaceId: string, name: string): string =>
    `${kind}\0${workspaceId}\0${normalizedName(name)}`;
  // What a teamspace retry can change since the try it may repeat; the name is in the key.
  const createRequest = (
    input: CreateSpaceInput,
    access: { memberIds: string[]; teamIds: string[] }
  ): string =>
    JSON.stringify([
      input.emoji ?? null,
      input.description ?? null,
      input.is_default ?? false,
      input.is_open ?? false,
      [...access.memberIds].sort(),
      [...access.teamIds].sort(),
    ]);

  // Sends a create and, when its answer may have been lost, looks for what it made. A lost answer
  // is no answer at all (see isLostAnswer); a taken name counts as one too while an earlier try of
  // the same create is still unsettled, since that try is the likely owner of the name. `find`
  // returns the caller's own match, null when there is none and undefined when it couldn't look.
  async function createSettling<T>(
    key: string,
    attempt: {
      send: () => Promise<T>;
      isNameTaken: (err: unknown) => boolean;
      find: (triedAt: number) => Promise<T | null | undefined>;
      // What this try asked for. An unsettled earlier try that asked for something else is not
      // adopted, since that would silently drop what this try changed; its answer stands. Omitted
      // when the caller applies this try's request to whatever it recovers.
      request?: string;
    }
  ): Promise<T> {
    const triedAt = Date.now();
    try {
      const created = await attempt.send();
      unsettledCreates.delete(key);
      return created;
    } catch (err) {
      const lastTry = unsettledCreates.get(key);
      const unsettled =
        lastTry !== undefined && triedAt - lastTry.triedAt <= UNSETTLED_CREATE_TTL_MS
          ? lastTry
          : undefined;
      const unsettledAt = unsettled?.triedAt;
      const request = attempt.request ?? "";
      const changed =
        attempt.request !== undefined && unsettled !== undefined && unsettled.request !== request;
      const mayBeOurs =
        !changed && (isLostAnswer(err) || (unsettledAt !== undefined && attempt.isNameTaken(err)));
      if (!mayBeOurs) {
        unsettledCreates.delete(key);
        throw err;
      }
      const found = await attempt.find(unsettledAt ?? triedAt);
      if (found === undefined)
        unsettledCreates.set(key, { triedAt: unsettledAt ?? triedAt, request });
      else unsettledCreates.delete(key);
      if (!found) throw err;
      return found;
    }
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
    const cloudSpace = await createSettling(createKey("space", workspaceId, input.name), {
      send: () =>
        deps.spaces.create(workspaceId, {
          ...input,
          member_ids: access.memberIds,
          team_ids: access.teamIds,
        }),
      isNameTaken: (err) => classifySpaceError(err).kind === "nameTaken",
      find: (triedAt) => findLostCreate(workspaceId, input.name, triedAt),
      request: createRequest(input, access),
    });
    const space = await deps.local.upsertSpaceFromCloud(
      cloudSpace as unknown as Record<string, unknown>
    );
    if (space) await deps.local.setSpaceSyncStatus(space.id, "synced");
    await deps.local.loadSpaces();
    deps.sync.requestSyncAll("manual");
    return space;
  }

  // The same test for a team, read through the team list: a lost create is the caller's own when
  // it is in this workspace under the name sent, the caller is its direct admin and it is new.
  async function findLostTeamCreate(
    workspaceId: string,
    name: string,
    triedAt: number
  ): Promise<Team | null | undefined> {
    const wanted = normalizedName(name);
    try {
      const teams = await deps.teams.list(workspaceId);
      return (
        teams.find(
          (team) =>
            team.workspace_id === workspaceId &&
            normalizedName(team.name) === wanted &&
            team.my_direct_role === "admin" &&
            Math.abs(triedAt - Date.parse(team.created_at)) <= LOST_CREATE_WINDOW_MS
        ) ?? null
      );
    } catch {
      return undefined;
    }
  }

  // Members travel in the create body, so the server adds them with the team or not at all. A team
  // found after a lost answer was made by an earlier try, with whoever that try sent; this try's
  // people are added through the batch route, which never changes a role. Someone the person
  // removed from the form between the tries stays on the team, since no call here takes them off.
  async function createTeam(
    workspaceId: string,
    input: { name: string; memberIds: string[] }
  ): Promise<Team> {
    const key = createKey("team", workspaceId, input.name);
    let sent = false;
    // When the create this team came from was first tried; it is what the lookup measured from.
    let originalTryAt: number | undefined;
    const team = await createSettling(key, {
      send: async () => {
        const created = await deps.teams.create(workspaceId, {
          name: input.name,
          member_ids: input.memberIds,
        });
        sent = true;
        return created;
      },
      isNameTaken: (err) => classifyTeamError(err).kind === "nameTaken",
      find: (triedAt) => {
        originalTryAt = triedAt;
        return findLostTeamCreate(workspaceId, input.name, triedAt);
      },
    });
    if (!sent && input.memberIds.length > 0) {
      try {
        await deps.teams.addMembers(team.id, input.memberIds);
      } catch (err) {
        // The team is still unreported, so the next try may recover it again. Marked with the
        // original time: a later one would drift out of the lost-create window of the team's
        // creation as retries pile up.
        unsettledCreates.set(key, { triedAt: originalTryAt ?? Date.now(), request: "" });
        throw err;
      }
    }
    return team;
  }

  async function addPeopleToTeam(
    teamId: string,
    userIds: string[]
  ): Promise<{ added: string[]; already_members: string[] }> {
    const result = await deps.teams.addMembers(teamId, userIds);
    await refreshMirrorAfterWrite();
    return result;
  }

  // Spaces list their teams by name, so the mirror follows a rename.
  async function renameTeam(teamId: string, name: string): Promise<Team> {
    const team = await deps.teams.update(teamId, { name });
    await refreshMirrorAfterWrite();
    return team;
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

  // The toast that ends the window goes with the page or the app, and it told the user this was
  // deleted. Best effort: quit waits 1.5 s for this (main.js). Offline, on a slower server, or
  // after a force-quit, a crash or an update install the delete may not land: the teamspace and its
  // public link stay, and it comes back at the next launch with no notice.
  async function commitHeldDeletes(): Promise<void> {
    await Promise.allSettled([...openHolds].map((hold) => hold.commit()));
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

  // Like holdSpaceDelete, without the mirror and purge work: a team has no local row, and the
  // spaces that list it are refreshed once the server has dropped it.
  function holdTeamDelete(team: Team): TeamDeleteHold {
    return holdTeamForAccount(team, deps.deleteHold.accountGeneration());
  }

  function holdTeamForAccount(team: Team, accountGeneration: number): TeamDeleteHold {
    const accountChanged = (): boolean => deps.deleteHold.accountGeneration() !== accountGeneration;
    deps.teamDeleteHold.hide(team.id);
    let settled = false;
    const hold: TeamDeleteHold = {
      async undo() {
        if (settled) return false;
        settled = true;
        openHolds.delete(hold);
        deps.teamDeleteHold.release(team.id);
        return true;
      },
      async commit() {
        if (settled) return null;
        settled = true;
        openHolds.delete(hold);
        if (accountChanged()) return null;
        try {
          await deps.teams.remove(team.id);
        } catch (err) {
          // Someone else deleted it first, or an earlier delete went through and its answer was
          // lost. Only the API's own "Team not found" proves that; a bare 404 proves nothing.
          const failure = classifyTeamError(err);
          if (failure.kind !== "gone") {
            deps.teamDeleteHold.release(team.id);
            return { success: false, error: errorMessage(err), failure };
          }
        }
        await refreshMirrorAfterWrite();
        // The People page lists the deleted team on each of its members until the roster is read
        // again. The delete went through, so a failed read isn't its failure.
        try {
          await deps.refreshWorkspaceRoster(team.workspace_id);
        } catch (err) {
          console.error("Workspace roster refresh failed after a team delete:", err);
        }
        deps.sync.requestSyncAll("manual");
        return { success: true };
      },
      again: () => (accountChanged() ? null : holdTeamForAccount(team, accountGeneration)),
    };
    openHolds.add(hold);
    return hold;
  }

  async function assignTeamToSpace(space: SpaceItem, teamId: string): Promise<void> {
    await deps.spaces.assignTeam(requireCloudSpaceId(space), teamId);
    await refreshMirrorAfterWrite();
  }

  // One request per teamspace, in order, every one tried: the POST is idempotent, so a retry can
  // resend only what failed. No access is sent, so a teamspace the team is already in keeps its
  // own. The mirror is read once, after all of them.
  async function assignTeamToSpaces(
    teamId: string,
    spaceIds: string[]
  ): Promise<{ failures: { spaceId: string; error: unknown }[] }> {
    const failures: { spaceId: string; error: unknown }[] = [];
    for (const spaceId of spaceIds) {
      try {
        await deps.spaces.assignTeam(spaceId, teamId);
      } catch (error) {
        failures.push({ spaceId, error });
      }
    }
    await refreshMirrorAfterWrite();
    return { failures };
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

  async function removeTeamMember(teamId: string, userId: string): Promise<void> {
    await deps.teams.removeMember(teamId, userId);
    await refreshMirrorAfterWrite();
  }

  async function setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
    await deps.teams.setMemberRole(teamId, userId, role);
    await refreshMirrorAfterWrite();
  }

  async function leaveTeam(teamId: string, userId: string): Promise<void> {
    try {
      await deps.teams.removeMember(teamId, userId);
    } catch (err) {
      const kind = classifyTeamError(err).kind;
      // Already out of the team, as after a leave that got partway: that is leaving.
      if (kind !== "memberGone") {
        // Deleted since: the mirror catches up, and the caller says the team is gone rather
        // than that the user left it.
        if (kind === "gone") {
          await refreshMirrorAfterWrite();
          deps.sync.requestSyncAll("manual");
        }
        throw err;
      }
    }
    await refreshMirrorAfterWrite();
    deps.sync.requestSyncAll("manual");
  }

  return {
    createSpace,
    renameSpace,
    deleteSpace,
    holdSpaceDelete,
    commitHeldDeletes,
    createTeam,
    addPeopleToTeam,
    renameTeam,
    holdTeamDelete,
    assignTeamToSpace,
    assignTeamToSpaces,
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
    removeTeamMember,
    setTeamMemberRole,
    leaveTeam,
  };
}
