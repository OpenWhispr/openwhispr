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
