import type { NoteItem, SpaceItem, TeamRole, WorkspaceRole } from "../types/electron";

export function canManageWorkspace(workspaceRole: WorkspaceRole | null | undefined): boolean {
  return workspaceRole === "owner" || workspaceRole === "admin";
}

/**
 * Whether the current user can manage a team space (rename, delete, assign
 * teams): an explicit space admin (best role across the space's assigned
 * teams, server-computed) or an implicit one via workspace owner/admin.
 * Client checks are cosmetic — the server enforces.
 */
export function canManageSpace(space: SpaceItem, workspaceRole: WorkspaceRole | null): boolean {
  return space.my_role === "admin" || canManageWorkspace(workspaceRole);
}

/**
 * Whether the current user can edit a specific team's roster: an explicit
 * admin of that team, or an implicit one via workspace owner/admin.
 */
export function canManageTeamRoster(
  teamMyRole: TeamRole | null | undefined,
  workspaceRole: WorkspaceRole | null
): boolean {
  return teamMyRole === "admin" || canManageWorkspace(workspaceRole);
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
type SpaceRef = Pick<SpaceItem, "kind" | "cloud_space_id" | "my_role">;

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
 * Delete a team-space note: the note's owner, a space admin, or a workspace
 * owner/admin. Mirrors the server rule — client checks are cosmetic.
 * Space rules only: a cloud-backed PERSONAL note shared with this user
 * passes here (private space is unenforced) but may still be vetoed by its
 * note-level ACL — compose with sharedNoteBlocksDelete (notePermissions).
 */
export function canDeleteSpaceNote(
  note: NoteOwnership,
  space: SpaceRef | null | undefined,
  currentUserId: string | null | undefined,
  workspaceRole: WorkspaceRole | null
): boolean {
  if (!isEnforcedTeamSpace(space)) return true;
  return (
    ownsNote(note, currentUserId) || space.my_role === "admin" || canManageWorkspace(workspaceRole)
  );
}

/**
 * Change a team-space note's scope (move it to another space): the note's
 * owner or a workspace owner/admin. A space admin who is only a workspace
 * member may delete a teammate's note but not change its audience.
 */
export function canChangeSpaceNoteScope(
  note: NoteOwnership,
  space: SpaceRef | null | undefined,
  currentUserId: string | null | undefined,
  workspaceRole: WorkspaceRole | null
): boolean {
  if (!isEnforcedTeamSpace(space)) return true;
  return ownsNote(note, currentUserId) || canManageWorkspace(workspaceRole);
}

/**
 * Move or delete a team-space folder: a space admin or a workspace
 * owner/admin. Members keep creating, renaming, and using folders — only the
 * destructive/scope-changing actions are gated.
 */
export function canMoveOrDeleteSpaceFolder(
  space: SpaceRef | null | undefined,
  workspaceRole: WorkspaceRole | null
): boolean {
  if (!isEnforcedTeamSpace(space)) return true;
  return space.my_role === "admin" || canManageWorkspace(workspaceRole);
}
