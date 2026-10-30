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

export function resolveWorkspaceSwitcher({
  isSignedIn,
  loaded,
  error,
  workspaces,
  activeWorkspaceId,
}: WorkspaceSwitcherInput): WorkspaceSwitcherState {
  if (!isSignedIn) return { kind: "hidden" };
  if (!loaded) return { kind: "loading" };
  if (workspaces.length === 0) {
    // Anyone in a workspace has one saved as active, so a failed load without one is a user who
    // had none last time: they stay Personal rather than seeing an error about workspaces.
    return error && activeWorkspaceId ? { kind: "error" } : { kind: "personal" };
  }
  const current = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  return { kind: "workspace", current, canInvite: workspaceCan(current, "manage_members") };
}
