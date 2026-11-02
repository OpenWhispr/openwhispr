import type { SpaceItem, Workspace } from "../types/electron";
import { workspaceCan } from "./capabilities.ts";

export function manageableWorkspaces(workspaces: Workspace[]): Workspace[] {
  return workspaces.filter((workspace) => workspaceCan(workspace, "create_spaces"));
}

type ScopedSpace = Pick<SpaceItem, "kind" | "workspace_id">;

function isListedWorkspace(workspaceId: string, workspaces: Workspace[]): boolean {
  return workspaces.some((workspace) => workspace.id === workspaceId);
}

/**
 * Whether a space shows while `activeWorkspaceId` is the active workspace.
 * Personal is account-level, so it shows in every workspace. A team space
 * whose workspace isn't listed (legacy rows, a list that hasn't loaded) stays
 * visible too, since no switch could ever reach it otherwise.
 */
export function isSpaceInWorkspaceScope(
  space: ScopedSpace,
  activeWorkspaceId: string | null,
  workspaces: Workspace[]
): boolean {
  if (space.kind === "private") return true;
  // An active id the list doesn't hold yet (still loading, just left) scopes nothing.
  if (activeWorkspaceId == null || !isListedWorkspace(activeWorkspaceId, workspaces)) return true;
  if (space.workspace_id == null || space.workspace_id === activeWorkspaceId) return true;
  return !isListedWorkspace(space.workspace_id, workspaces);
}

export function spacesInWorkspaceScope<S extends ScopedSpace>(
  spaces: S[],
  activeWorkspaceId: string | null,
  workspaces: Workspace[]
): S[] {
  return spaces.filter((space) => isSpaceInWorkspaceScope(space, activeWorkspaceId, workspaces));
}

export type NoteWorkspaceScopeDecision =
  | { kind: "none" }
  | { kind: "enterWorkspace"; workspaceId: string }
  | { kind: "leaveHidden"; clearNote: boolean; context: "keep" | "note" | "default" };

export type NoteWorkspaceScopeReason = "workspaceSwitched" | "navigated" | "dataChanged";

/**
 * Keeps the open note and container inside the active workspace. Switching
 * workspaces leaves whatever the switch hid; opening a space or note of
 * another workspace (a search result, a link, an invitation) switches to it.
 * Data changing under the open note (a sync, an undone move) never switches:
 * it leaves what it hid, like a switch.
 */
export function decideNoteWorkspaceScope(input: {
  reason: NoteWorkspaceScopeReason;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  contextSpace: ScopedSpace | null;
  noteSpace: ScopedSpace | null;
}): NoteWorkspaceScopeDecision {
  const { reason, activeWorkspaceId, workspaces, contextSpace, noteSpace } = input;
  const hidden = (space: ScopedSpace | null): boolean =>
    space != null && !isSpaceInWorkspaceScope(space, activeWorkspaceId, workspaces);
  const noteHidden = hidden(noteSpace);
  const contextHidden = hidden(contextSpace);

  if (!noteHidden && !contextHidden) return { kind: "none" };
  if (reason === "navigated") {
    // Navigation sets the container and the note one after the other, so
    // whichever moved into another workspace takes the user there; the note
    // wins when both did.
    const target = noteHidden ? noteSpace : contextSpace;
    if (target?.workspace_id) return { kind: "enterWorkspace", workspaceId: target.workspace_id };
  }
  const keepsNote = noteSpace != null && !noteHidden;
  return {
    kind: "leaveHidden",
    clearNote: noteHidden,
    context: !contextHidden ? "keep" : keepsNote ? "note" : "default",
  };
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
