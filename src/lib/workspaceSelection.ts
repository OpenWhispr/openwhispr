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
 *
 * A Private bound to a workspace shows in that workspace alone, listed or not. The pending Private
 * (no workspace yet; signed out, the stand-in) holds the default workspace's notes until main
 * binds it, so it shows in the default workspace, and wherever no default is known yet (signed
 * out, the list still loading, a list that names none): hiding it then would take the account's
 * notes away on every launch until the list answers.
 *
 * A team space whose workspace isn't listed (legacy rows, a list that hasn't loaded) stays
 * visible, since no switch could ever reach it otherwise.
 */
export function isSpaceInWorkspaceScope(
  space: ScopedSpace,
  activeWorkspaceId: string | null,
  workspaces: Workspace[],
  defaultWorkspaceId: string | null
): boolean {
  if (space.kind === "private") {
    if (space.workspace_id != null) return space.workspace_id === activeWorkspaceId;
    return defaultWorkspaceId == null || activeWorkspaceId === defaultWorkspaceId;
  }
  // An active id the list doesn't hold yet (still loading, just left) scopes nothing.
  if (activeWorkspaceId == null || !isListedWorkspace(activeWorkspaceId, workspaces)) return true;
  if (space.workspace_id == null || space.workspace_id === activeWorkspaceId) return true;
  return !isListedWorkspace(space.workspace_id, workspaces);
}

export function spacesInWorkspaceScope<S extends ScopedSpace>(
  spaces: S[],
  activeWorkspaceId: string | null,
  workspaces: Workspace[],
  defaultWorkspaceId: string | null
): S[] {
  return spaces.filter((space) =>
    isSpaceInWorkspaceScope(space, activeWorkspaceId, workspaces, defaultWorkspaceId)
  );
}

type AssistantSpace = ScopedSpace & Pick<SpaceItem, "id" | "is_default_private">;

/**
 * The default workspace as far as this window knows without asking main to make anything: the one
 * a workspace list names (`listedDefaultId`: this window's, or the last one cached), else the one
 * main last bound the account's Private to. Null when nothing says.
 */
export function knownDefaultWorkspaceId(
  listedDefaultId: string | null,
  spaces: AssistantSpace[]
): string | null {
  if (listedDefaultId != null) return listedDefaultId;
  const bound = spaces.find((space) => space.kind === "private" && space.is_default_private === 1);
  return bound?.workspace_id ?? null;
}

/**
 * The spaces whose notes the assistant may read while `activeWorkspaceId` is active, from rows
 * that already exist (D37: working out the scope never makes one). A window holding the workspace
 * list (the control panel) reads what its tree shows. Without it (the dictation window, or a list
 * that doesn't hold the active workspace yet) the scope is the Private bound to the active
 * workspace, the pending Private too while the default isn't known or is the active workspace (as
 * the tree merges it, D20), and the active workspace's teamspaces and those linked to no
 * workspace. A Private bound to another workspace never counts. With no active workspace nothing
 * says which teamspaces are in scope, so main's Private alone is: never every space.
 */
export function assistantScopeSpaceIds(input: {
  spaces: AssistantSpace[];
  activeWorkspaceId: string | null;
  /** The window's workspace list; empty where it has none. */
  workspaces: Workspace[];
  /** The default the window's list names; without a list, the last cached list's. */
  defaultWorkspaceId: string | null;
  /** Main's Private for its own active workspace (getPrivateSpaceId with no workspace). */
  privateSpaceId: number | null;
}): number[] {
  const { spaces, activeWorkspaceId, workspaces, privateSpaceId } = input;
  if (activeWorkspaceId == null) return privateSpaceId == null ? [] : [privateSpaceId];
  if (isListedWorkspace(activeWorkspaceId, workspaces)) {
    return spacesInWorkspaceScope(
      spaces,
      activeWorkspaceId,
      workspaces,
      input.defaultWorkspaceId
    ).map((space) => space.id);
  }
  const knownDefault = knownDefaultWorkspaceId(input.defaultWorkspaceId, spaces);
  const pendingCounts = knownDefault == null || knownDefault === activeWorkspaceId;
  return spaces
    .filter((space) =>
      space.kind === "private"
        ? space.workspace_id === activeWorkspaceId || (space.workspace_id == null && pendingCounts)
        : space.workspace_id == null || space.workspace_id === activeWorkspaceId
    )
    .map((space) => space.id);
}

/**
 * The Private the active workspace shows, from spaces already in scope: its own, else the pending
 * one. Both are in scope while the default workspace's own Private waits for main to bind the
 * pending one into it.
 */
export function activePrivateSpace<S extends ScopedSpace>(scoped: S[]): S | null {
  let pending: S | null = null;
  for (const space of scoped) {
    if (space.kind !== "private") continue;
    if (space.workspace_id != null) return space;
    pending ??= space;
  }
  return pending;
}

export type NoteWorkspaceScopeDecision =
  | { kind: "none" }
  | { kind: "enterWorkspace"; workspaceId: string }
  | { kind: "leaveHidden"; clearNote: boolean; context: "keep" | "note" | "default" };

export type NoteWorkspaceScopeReason = "workspaceSwitched" | "navigated" | "dataChanged";

/**
 * Keeps the open note and container inside the active workspace. Switching
 * workspaces leaves whatever the switch hid; opening a space or note of
 * another workspace (a search result, a link, an invitation) switches to it,
 * when the list holds that workspace or hasn't loaded yet. Data changing under
 * the open note (a sync, an undone move) never switches: it leaves what it
 * hid, like a switch.
 */
export function decideNoteWorkspaceScope(input: {
  reason: NoteWorkspaceScopeReason;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  defaultWorkspaceId: string | null;
  contextSpace: ScopedSpace | null;
  noteSpace: ScopedSpace | null;
}): NoteWorkspaceScopeDecision {
  const { reason, activeWorkspaceId, workspaces, defaultWorkspaceId, contextSpace, noteSpace } =
    input;
  const hidden = (space: ScopedSpace | null): boolean =>
    space != null &&
    !isSpaceInWorkspaceScope(space, activeWorkspaceId, workspaces, defaultWorkspaceId);
  const noteHidden = hidden(noteSpace);
  const contextHidden = hidden(contextSpace);

  if (!noteHidden && !contextHidden) return { kind: "none" };
  if (reason === "navigated") {
    // Navigation sets the container and the note one after the other, so
    // whichever moved into another workspace takes the user there; the note
    // wins when both did.
    const target = noteHidden ? noteSpace : contextSpace;
    // The pending Private is the default workspace's until main binds it.
    const workspaceId =
      target?.kind === "private" && target.workspace_id == null
        ? defaultWorkspaceId
        : target?.workspace_id;
    // A Private whose workspace the list no longer holds is on its way to the default's: entering
    // that workspace would leave the switcher on nothing it lists.
    if (workspaceId && (workspaces.length === 0 || isListedWorkspace(workspaceId, workspaces))) {
      return { kind: "enterWorkspace", workspaceId };
    }
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
