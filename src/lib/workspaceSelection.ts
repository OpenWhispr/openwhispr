import type { Workspace } from "../types/electron";
import { canManageWorkspace } from "./spacePermissions.ts";

export function manageableWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => canManageWorkspace(workspace.role));
}

export interface TeamSpaceGroup<S> {
  workspace: Workspace;
  spaces: S[];
}

export function groupTeamSpacesByWorkspace<S extends { workspace_id?: string | null }>(
  workspaces: Workspace[],
  teamSpaces: S[]
): { groups: TeamSpaceGroup<S>[]; ungrouped: S[]; ordered: S[] } {
  const groups = workspaces
    .map((workspace) => ({
      workspace,
      spaces: teamSpaces.filter((space) => space.workspace_id === workspace.id),
    }))
    // Empty groups stay visible for owners/admins so the per-workspace
    // create button always has a row to live on.
    .filter((group) => group.spaces.length > 0 || canManageWorkspace(group.workspace.role));
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const ungrouped = teamSpaces.filter(
    (space) => space.workspace_id == null || !workspaceIds.has(space.workspace_id)
  );
  // Canonical visual order used by both rendering and keyboard navigation:
  // workspace order first, then legacy/unrecognized spaces.
  const ordered = [...groups.flatMap((group) => group.spaces), ...ungrouped];
  return { groups, ungrouped, ordered };
}

export function selectWorkspaceForSpaceCreation(
  manageable: Workspace[],
  active: Workspace | null,
  selectedWorkspaceId: string | null
): Workspace | null {
  const selected = manageable.find((workspace) => workspace.id === selectedWorkspaceId);
  if (selected) return selected;
  const activeManageable = active && manageable.find((workspace) => workspace.id === active.id);
  return activeManageable ?? manageable[0] ?? null;
}
