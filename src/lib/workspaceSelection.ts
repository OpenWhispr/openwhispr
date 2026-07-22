import type { Workspace } from "../types/electron";

export function manageableWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => workspace.role === "owner" || workspace.role === "admin");
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
