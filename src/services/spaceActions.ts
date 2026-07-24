import { TeamsService } from "./TeamsService";
import { SpacesService } from "./SpacesService";
import { markSpacePurged, readPurgedSpaceIds, syncService } from "./SyncService";
import { loadSpaces, purgeSpace, updateSpaceMeta } from "../stores/noteStore";
import type { SpaceItem, TeamRole } from "../types/electron";

// Single mutation path for spaces and their backing teams: server call → local
// SQLite mirror → store refresh. Roster and team mutations are space-agnostic
// (a team can back many spaces), so they re-mirror every cloud space rather
// than patching one row — my_role, member_count (deduped union) and the teams
// list are always server-computed.

function requireCloudSpaceId(space: SpaceItem): string {
  if (!space.cloud_space_id) throw new Error("Not a cloud space");
  return space.cloud_space_id;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

async function settleAddMembers(teamId: string, userIds: string[]): Promise<unknown[]> {
  const results = await Promise.allSettled(
    userIds.map((userId) => TeamsService.addMember(teamId, userId))
  );
  return results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
}

async function refreshSpaceMirror(): Promise<void> {
  const cloudSpaces = await SpacesService.mySpaces();
  const purged = readPurgedSpaceIds();
  for (const cloudSpace of cloudSpaces) {
    // A purge racing this refresh must not resurrect the space.
    if (purged[cloudSpace.id]) continue;
    await window.electronAPI.upsertSpaceFromCloud?.(
      cloudSpace as unknown as Record<string, unknown>
    );
  }
  await loadSpaces();
}

export async function createSpace(
  workspaceId: string,
  input: { name: string; emoji?: string | null },
  teams: { existingTeamIds: string[]; newTeam?: { name: string; memberIds: string[] } }
): Promise<{ space: SpaceItem | null; failedMembers: number }> {
  const teamIds = [...teams.existingTeamIds];
  let failedMembers = 0;
  if (teams.newTeam) {
    const team = await TeamsService.create(workspaceId, { name: teams.newTeam.name });
    failedMembers = (await settleAddMembers(team.id, teams.newTeam.memberIds)).length;
    teamIds.push(team.id);
  }
  const cloudSpace = await SpacesService.create(workspaceId, {
    name: input.name,
    emoji: input.emoji,
    team_ids: teamIds,
  });
  const space =
    (await window.electronAPI.upsertSpaceFromCloud?.(
      cloudSpace as unknown as Record<string, unknown>
    )) ?? null;
  // Cloud upserts insert as 'pending' (backfill marker); a space created this
  // second has no pre-existing content, so settle it — no skeletons.
  if (space) await window.electronAPI.setSpaceSyncStatus?.(space.id, "synced");
  await loadSpaces();
  syncService.requestSyncAll("manual");
  return { space, failedMembers };
}

export async function renameSpace(
  space: SpaceItem,
  updates: { name: string; emoji: string | null }
): Promise<{ success: boolean; error?: string }> {
  const local = await updateSpaceMeta(space.id, updates);
  if (!local.success) return local;
  if (!space.cloud_space_id) return { success: true };
  try {
    await SpacesService.update(space.cloud_space_id, updates);
    return { success: true };
  } catch (err) {
    await updateSpaceMeta(space.id, { name: space.name, emoji: space.emoji ?? null });
    return { success: false, error: errorMessage(err) };
  }
}

export async function deleteSpace(
  space: SpaceItem
): Promise<{ success: boolean; error?: string }> {
  if (space.cloud_space_id) {
    try {
      // Server archives the space; its teams survive as workspace entities and
      // members purge on their next spaces pass.
      await SpacesService.remove(space.cloud_space_id);
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
    // Park the space id so an in-flight pull can't resurrect purged rows.
    await markSpacePurged(space.cloud_space_id);
  }
  // Store cleanup rides on the space-purged broadcast.
  return purgeSpace(space.id);
}

// Fresh assignments get the server-side 'member' default; promotion to admin
// is a separate, explicit act via setSpaceTeamAccess.
export async function assignTeamToSpace(space: SpaceItem, teamId: string): Promise<void> {
  await SpacesService.assignTeam(requireCloudSpaceId(space), teamId);
  await refreshSpaceMirror();
}

// Changes an assignment's access cap via the upserting teams POST. May change
// the caller's own my_role — including dropping their admin on this space —
// which the mirror refresh picks up. Membership presence is untouched, so no
// content re-sync is needed.
export async function setSpaceTeamAccess(
  space: SpaceItem,
  teamId: string,
  access: "admin" | "member"
): Promise<void> {
  await SpacesService.assignTeam(requireCloudSpaceId(space), teamId, access);
  await refreshSpaceMirror();
}

// Unassigning may cost the caller their own access (last of their teams on the
// space): the follow-up sync pass purges the space locally in that case.
export async function unassignTeamFromSpace(space: SpaceItem, teamId: string): Promise<void> {
  await SpacesService.unassignTeam(requireCloudSpaceId(space), teamId);
  await refreshSpaceMirror();
  syncService.requestSyncAll("manual");
}

export async function addTeamMembers(
  teamId: string,
  userIds: string[]
): Promise<{ failures: unknown[] }> {
  const failures = await settleAddMembers(teamId, userIds);
  await refreshSpaceMirror();
  return { failures };
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  await TeamsService.removeMember(teamId, userId);
  await refreshSpaceMirror();
}

export async function setTeamMemberRole(
  teamId: string,
  userId: string,
  role: TeamRole
): Promise<void> {
  // The members POST upserts (ON CONFLICT DO UPDATE): role change via add.
  await TeamsService.addMember(teamId, userId, role);
  await refreshSpaceMirror();
}

// Self-removal from a team. Spaces backed only by this team disappear on the
// follow-up sync pass (never purged here: other teams may still grant access).
export async function leaveTeam(teamId: string, userId: string): Promise<void> {
  await TeamsService.removeMember(teamId, userId);
  await refreshSpaceMirror();
  syncService.requestSyncAll("manual");
}

export async function renameTeam(teamId: string, name: string): Promise<void> {
  await TeamsService.update(teamId, { name });
  // Team names are mirrored inside each space's teams list.
  await refreshSpaceMirror();
}

// Archives the team. Never marks the purge guard: spaces it backed may survive
// via other teams — the follow-up sync pass decides what disappears.
export async function deleteTeam(teamId: string): Promise<void> {
  await TeamsService.remove(teamId);
  await refreshSpaceMirror();
  syncService.requestSyncAll("manual");
}
