import type { Workspace } from "../types/electron";
import { workspaceCan } from "./capabilities.ts";
import { isEnterpriseWorkspaceEntitled } from "../components/onboarding/flow.ts";

export type WorkspaceSwitcherState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "personal" }
  | { kind: "workspace"; current: Workspace; canInvite: boolean };

interface WorkspaceSwitcherInput {
  isSignedIn: boolean;
  loaded: boolean;
  error: boolean;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  personalSelected: boolean;
}

/**
 * The workspace to make active when none is chosen. An Enterprise workspace comes first, since its
 * managed providers apply only while it is active (onboarding picks it the same way).
 */
export function defaultActiveWorkspaceId(
  workspaces: Array<Pick<Workspace, "id" | "plan" | "status">>
): string | null {
  return (workspaces.find(isEnterpriseWorkspaceEntitled) ?? workspaces[0])?.id ?? null;
}

/**
 * Whether Personal can be picked over a workspace. Beside an entitled Enterprise workspace it can't:
 * leaving that workspace would take dictation off its managed providers without saying so.
 */
export function canChoosePersonal(workspaces: Array<Pick<Workspace, "plan" | "status">>): boolean {
  return workspaces.length > 0 && !workspaces.some(isEnterpriseWorkspaceEntitled);
}

/** The workspace Settings manages. Personal is none, so its pages never show another workspace. */
export function settingsWorkspace(
  workspaces: Workspace[],
  activeWorkspaceId: string | null,
  personalSelected: boolean
): Workspace | null {
  if (personalSelected) return null;
  return workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
}

export function resolveWorkspaceSwitcher({
  isSignedIn,
  loaded,
  error,
  workspaces,
  activeWorkspaceId,
  personalSelected,
}: WorkspaceSwitcherInput): WorkspaceSwitcherState {
  if (!isSignedIn) return { kind: "hidden" };
  if (!loaded) return { kind: "loading" };
  if (workspaces.length === 0) {
    // Anyone in a workspace has one saved as active or chose Personal, so a failed load without
    // either is a user who had none last time: they stay Personal rather than seeing an error.
    return error && (activeWorkspaceId || personalSelected)
      ? { kind: "error" }
      : { kind: "personal" };
  }
  if (personalSelected) return { kind: "personal" };
  const current = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  return { kind: "workspace", current, canInvite: workspaceCan(current, "manage_members") };
}
