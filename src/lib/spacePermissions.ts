import type { SpaceItem, TeamRole, WorkspaceRole } from "../types/electron";

/**
 * Whether the current user can manage a team space (rename, delete, assign
 * teams): an explicit space admin (best role across the space's assigned
 * teams, server-computed) or an implicit one via workspace owner/admin.
 * Client checks are cosmetic — the server enforces.
 */
export function canManageSpace(space: SpaceItem, workspaceRole: WorkspaceRole | null): boolean {
  return space.my_role === "admin" || workspaceRole === "owner" || workspaceRole === "admin";
}

/**
 * Whether the current user can edit a specific team's roster: an explicit
 * admin of that team, or an implicit one via workspace owner/admin.
 */
export function canManageTeamRoster(
  teamMyRole: TeamRole | null | undefined,
  workspaceRole: WorkspaceRole | null
): boolean {
  return teamMyRole === "admin" || workspaceRole === "owner" || workspaceRole === "admin";
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
