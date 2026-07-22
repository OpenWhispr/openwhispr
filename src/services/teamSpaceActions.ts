import { TeamsService } from "./TeamsService";
import { markTeamSpacePurged, syncService } from "./SyncService";
import { loadSpaces, purgeSpace, updateSpaceMeta } from "../stores/noteStore";
import { useWorkspaceStore } from "../stores/workspaceStore";
import type { SpaceItem, TeamMember, TeamRole } from "../types/electron";

// Single mutation path for team spaces: server call → local SQLite mirror → store refresh.

function requireTeamId(space: SpaceItem): string {
  if (!space.cloud_team_id) throw new Error("Not a cloud team space");
  return space.cloud_team_id;
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

/** Refetch the roster and mirror its size into the local space row (narrow update). */
async function syncRoster(space: SpaceItem, teamId: string): Promise<TeamMember[]> {
  const roster = await TeamsService.listMembers(teamId);
  await window.electronAPI.updateSpaceMemberCount?.(space.id, roster.length);
  await loadSpaces();
  return roster;
}

export async function createTeamSpace(
  workspaceId: string,
  input: { name: string; emoji?: string | null },
  memberIds: string[] = []
): Promise<{ space: SpaceItem | null; failedMembers: number }> {
  const team = await TeamsService.create(workspaceId, input);
  const failedMembers = (await settleAddMembers(team.id, memberIds)).length;
  // member_count mirrors the server's explicit roster; the creator is implicit.
  const space =
    (await window.electronAPI.upsertSpaceFromCloud?.({
      ...team,
      my_role: "admin",
      member_count: memberIds.length - failedMembers,
    })) ?? null;
  // Cloud upserts insert as 'pending' (backfill marker); a team created this
  // second has no pre-existing content, so settle it — no skeletons.
  if (space) await window.electronAPI.setSpaceSyncStatus?.(space.id, "synced");
  await loadSpaces();
  syncService.requestSyncAll("manual");
  return { space, failedMembers };
}

export async function renameTeamSpace(
  space: SpaceItem,
  updates: { name: string; emoji: string | null }
): Promise<{ success: boolean; error?: string }> {
  // Optimistic local rename; reverted below if the server rejects it.
  const local = await updateSpaceMeta(space.id, updates);
  if (!local.success) return local;
  if (!space.cloud_team_id) return { success: true };
  try {
    await TeamsService.update(space.cloud_team_id, updates);
    return { success: true };
  } catch (err) {
    await updateSpaceMeta(space.id, { name: space.name, emoji: space.emoji ?? null });
    return { success: false, error: errorMessage(err) };
  }
}

export async function deleteTeamSpace(
  space: SpaceItem
): Promise<{ success: boolean; error?: string }> {
  if (space.cloud_team_id) {
    try {
      // Server archives the team; teammates purge on their next spaces pass.
      await TeamsService.remove(space.cloud_team_id);
    } catch (err) {
      return { success: false, error: errorMessage(err) };
    }
    // Park the team id so an in-flight pull can't resurrect purged rows.
    await markTeamSpacePurged(space.cloud_team_id);
  }
  // Store cleanup rides on the space-purged broadcast.
  return purgeSpace(space.id);
}

/**
 * A "leave" by an implicit workspace owner/admin (no team_members row) is a
 * server no-op — purging locally would only resurrect the space on the next
 * sync pass, so the roster is re-checked and "implicit" returns without purging.
 */
export async function leaveTeamSpace(
  space: SpaceItem,
  userId: string
): Promise<"left" | "implicit"> {
  const teamId = requireTeamId(space);
  const workspaceRole = useWorkspaceStore
    .getState()
    .workspaces.find((w) => w.id === space.workspace_id)?.role;
  const isImplicitAdmin = workspaceRole === "owner" || workspaceRole === "admin";
  const roster = await TeamsService.listMembers(teamId);
  if (isImplicitAdmin || !roster.some((m) => m.user_id === userId)) return "implicit";
  await TeamsService.removeMember(teamId, userId);
  await markTeamSpacePurged(teamId);
  await purgeSpace(space.id);
  return "left";
}

export async function setMemberRole(
  space: SpaceItem,
  userId: string,
  role: TeamRole
): Promise<TeamMember[]> {
  const teamId = requireTeamId(space);
  // The members POST upserts (ON CONFLICT DO UPDATE): role change via add.
  await TeamsService.addMember(teamId, userId, role);
  return syncRoster(space, teamId);
}

export async function addMembers(
  space: SpaceItem,
  userIds: string[]
): Promise<{ roster: TeamMember[]; failures: unknown[] }> {
  const teamId = requireTeamId(space);
  const failures = await settleAddMembers(teamId, userIds);
  const roster = await syncRoster(space, teamId);
  return { roster, failures };
}

export async function removeMember(space: SpaceItem, userId: string): Promise<TeamMember[]> {
  const teamId = requireTeamId(space);
  await TeamsService.removeMember(teamId, userId);
  return syncRoster(space, teamId);
}
