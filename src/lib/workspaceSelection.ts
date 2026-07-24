import type { Workspace } from "../types/electron";

export function manageableWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => workspace.role === "owner" || workspace.role === "admin");
}

export interface TeamSpaceGroup<S> {
  workspace: Workspace;
  spaces: S[];
}

export function groupTeamSpacesByWorkspace<S extends { workspace_id?: string | null }>(
  workspaces: Workspace[],
  teamSpaces: S[]
): { groups: TeamSpaceGroup<S>[]; ungrouped: S[] } {
  const groups = workspaces
    .map((workspace) => ({
      workspace,
      spaces: teamSpaces.filter((space) => space.workspace_id === workspace.id),
    }))
    // Empty groups stay visible for owners/admins so the per-workspace
    // create button always has a row to live on.
    .filter(
      (group) =>
        group.spaces.length > 0 ||
        group.workspace.role === "owner" ||
        group.workspace.role === "admin"
    );
  const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
  const ungrouped = teamSpaces.filter(
    (space) => space.workspace_id == null || !workspaceIds.has(space.workspace_id)
  );
  return { groups, ungrouped };
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
