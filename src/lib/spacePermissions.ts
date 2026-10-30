import type { NoteItem, SpaceItem, SpaceTeamRef, TeamRole, Workspace } from "../types/electron";
import { spaceCan, workspaceCan } from "./capabilities.ts";

type WorkspaceRef = Pick<Workspace, "role" | "capabilities">;

/**
 * Teams the current user can give up to leave a space: those they explicitly
 * belong to. Workspace owners/admins may hold access with no team membership
 * at all, in which case there is nothing to leave.
 */
export function teamsUserCanLeave(space: Pick<SpaceItem, "teams">): SpaceTeamRef[] {
  return space.teams.filter((team) => team.my_role != null);
}

/**
 * Whether the current user can edit a specific team's roster: an explicit
 * admin of that team, or anyone the workspace lets manage teams.
 */
export function canManageTeamRoster(
  teamMyRole: TeamRole | null | undefined,
  workspace: WorkspaceRef | null | undefined
): boolean {
  return teamMyRole === "admin" || workspaceCan(workspace, "manage_teams");
}

/**
 * Whether a note or folder may move between two spaces: anything may leave a
 * private space, while team-space content stays within its workspace — never
 * to another workspace and never back to private. Team spaces not linked to a
 * workspace (legacy mirrors) never match, so nothing moves out of them.
 */
export function canMoveBetweenSpaces(
  from: Pick<SpaceItem, "kind" | "workspace_id">,
  to: Pick<SpaceItem, "kind" | "workspace_id">
): boolean {
  if (from.kind === "private") return true;
  return to.kind === "team" && from.workspace_id != null && from.workspace_id === to.workspace_id;
}

type NoteOwnership = Pick<NoteItem, "cloud_id" | "owner_user_id">;
type SpaceRef = Pick<
  SpaceItem,
  "kind" | "cloud_space_id" | "my_role" | "my_direct_role" | "teams" | "capabilities"
>;

// Only cloud-backed team spaces carry server-enforced roles; private and
// local-only spaces (no cloud id yet) stay fully manageable by their local
// owner. An unresolved space is treated the same — nothing to enforce against.
function isEnforcedTeamSpace(space: SpaceRef | null | undefined): space is SpaceRef {
  return space?.kind === "team" && !!space.cloud_space_id;
}

// Whether the current user owns the note. Rows without a cloud copy were
// created on this device, so they belong to the current user; cloud-backed
// rows fail closed while their owner is still unknown (owner_user_id NULL,
// pending the ownership backfill). owner_user_id is the creator — never
// inferred from updated_by_user_id, which only names the last editor.
export function ownsNote(note: NoteOwnership, currentUserId: string | null | undefined): boolean {
  if (!note.cloud_id) return true;
  return note.owner_user_id != null && note.owner_user_id === currentUserId;
}

/**
 * Delete a team-space note: the note's owner, or someone with manage_settings
 * on the space or the workspace (owner/admin under the role fallback).
 * Mirrors the server rule — client checks are cosmetic.
 * Space rules only: a cloud-backed PERSONAL note shared with this user
 * passes here (private space is unenforced) but may still be vetoed by its
 * note-level ACL — compose with sharedNoteBlocksDelete (notePermissions).
 */
export function canDeleteSpaceNote(
  note: NoteOwnership,
  space: SpaceRef | null | undefined,
  currentUserId: string | null | undefined,
  workspace: WorkspaceRef | null | undefined
): boolean {
  if (!isEnforcedTeamSpace(space)) return true;
  return (
    ownsNote(note, currentUserId) ||
    spaceCan(space, "manage_settings") ||
    workspaceCan(workspace, "manage_settings")
  );
}

/**
 * Change a team-space note's scope (move it to another space): the note's
 * owner or a workspace with manage_settings. Space-level manage_settings alone
 * may delete a teammate's note but not change its audience.
 */
export function canChangeSpaceNoteScope(
  note: NoteOwnership,
  space: SpaceRef | null | undefined,
  currentUserId: string | null | undefined,
  workspace: WorkspaceRef | null | undefined
): boolean {
  if (!isEnforcedTeamSpace(space)) return true;
  return ownsNote(note, currentUserId) || workspaceCan(workspace, "manage_settings");
}

/**
 * Move or delete a team-space folder: manage_settings on the space or the
 * workspace (admins/owners under the role fallback). Members keep creating,
 * renaming, and using folders — only the destructive/scope-changing actions
 * are gated.
 */
export function canMoveOrDeleteSpaceFolder(
  space: SpaceRef | null | undefined,
  workspace: WorkspaceRef | null | undefined
): boolean {
  if (!isEnforcedTeamSpace(space)) return true;
  return spaceCan(space, "manage_settings") || workspaceCan(workspace, "manage_settings");
}
