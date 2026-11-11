import type { TFunction } from "i18next";
import type { Workspace } from "../types/electron";
import { workspaceCan } from "./capabilities.ts";
import { isEnterpriseWorkspaceEntitled } from "../components/onboarding/flow.ts";

export type WorkspaceSwitcherState =
  | { kind: "hidden" }
  | { kind: "loading" }
  | { kind: "error" }
  // Listed, but the default workspace isn't there yet: making it failed or is still on its way.
  | { kind: "unavailable" }
  | { kind: "workspace"; current: Workspace; canInvite: boolean };

interface WorkspaceSwitcherInput {
  isSignedIn: boolean;
  loaded: boolean;
  error: boolean;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

type DefaultCandidate = Pick<Workspace, "id" | "plan" | "status"> & { is_default?: boolean };

// Lists cached by builds from before the default workspace have no is_default.
function isOwnDefault(workspace: DefaultCandidate): boolean {
  return workspace.is_default === true;
}

/**
 * The account's default workspace: its own, else its entitled Enterprise workspace (the server
 * makes no default for an Enterprise member). Existing private notes live there. Null until the
 * list holds either.
 */
export function resolveDefaultWorkspaceId(workspaces: DefaultCandidate[]): string | null {
  return (
    (workspaces.find(isOwnDefault) ?? workspaces.find(isEnterpriseWorkspaceEntitled))?.id ?? null
  );
}

/**
 * The workspace to make active when none is chosen: the account's default before the first
 * listed. An entitled Enterprise workspace still comes first, since its managed providers apply
 * only while it is active (onboarding picks it the same way).
 */
export function defaultActiveWorkspaceId(workspaces: DefaultCandidate[]): string | null {
  return (
    (
      workspaces.find(isEnterpriseWorkspaceEntitled) ??
      workspaces.find(isOwnDefault) ??
      workspaces[0]
    )?.id ?? null
  );
}

// The API's limit for a workspace name.
const MAX_WORKSPACE_NAME_LENGTH = 80;

/** The name the default workspace is created with: the user's, or a generic one. */
export function defaultWorkspaceName(userName: string | null | undefined, t: TFunction): string {
  const name = userName?.trim();
  const named = name ? t("workspaces.defaultName", { name }) : null;
  return named && named.length <= MAX_WORKSPACE_NAME_LENGTH
    ? named
    : t("workspaces.defaultNameFallback");
}

/** The default workspace first, the rest in their order. */
export function withDefaultFirst<W extends { id: string }>(
  workspaces: W[],
  defaultWorkspaceId: string | null
): W[] {
  const index = workspaces.findIndex((w) => w.id === defaultWorkspaceId);
  if (index <= 0) return workspaces;
  return [workspaces[index], ...workspaces.slice(0, index), ...workspaces.slice(index + 1)];
}

/**
 * Where a workspace's private notes go when the user leaves or deletes it: the default among the
 * workspaces left (as `forgetWorkspace` picks it), else the default the server makes next, by the
 * name it is made with.
 */
export function privateNotesDestinationName(
  workspaces: Workspace[],
  exitingWorkspaceId: string | null,
  userName: string | null | undefined,
  t: TFunction
): string {
  const remaining = workspaces.filter((w) => w.id !== exitingWorkspaceId);
  const defaultId = resolveDefaultWorkspaceId(remaining);
  const listedName = remaining.find((w) => w.id === defaultId)?.name?.trim();
  return listedName || defaultWorkspaceName(userName, t);
}

/** The workspace Settings manages: the active one, or the first when the active id is gone. */
export function settingsWorkspace(
  workspaces: Workspace[],
  activeWorkspaceId: string | null
): Workspace | null {
  return workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
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
  // Every account has a default workspace, so an empty list is either a failed load or one
  // answered before the default was made. Making it can keep failing (offline, an older API),
  // so this never waits on it: the account's Private stays reachable meanwhile.
  if (workspaces.length === 0) return error ? { kind: "error" } : { kind: "unavailable" };
  const current = workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0];
  return { kind: "workspace", current, canInvite: workspaceCan(current, "manage_members") };
}
