import type { PlansBillingRequest } from "./settingsNav";
import type { Workspace } from "../types/electron";

export type PlansBillingView =
  | { kind: "personal" }
  | { kind: "workspace"; workspace: Workspace }
  | { kind: "workspaceLoading"; workspaceId: string }
  | { kind: "workspaceUnavailable"; workspaceId: string };

export interface WorkspaceListState {
  loaded: boolean;
  error: boolean;
  workspaces: Workspace[];
}

export function resolveBillingView(
  request: PlansBillingRequest,
  list: WorkspaceListState
): PlansBillingView {
  if (request.kind === "personal") return { kind: "personal" };
  // A cached list counts even when the latest refresh failed.
  const workspace = list.workspaces.find((candidate) => candidate.id === request.workspaceId);
  if (workspace) return { kind: "workspace", workspace };
  if (!list.loaded) return { kind: "workspaceLoading", workspaceId: request.workspaceId };
  if (list.error) return { kind: "workspaceUnavailable", workspaceId: request.workspaceId };
  return { kind: "personal" };
}

/** Personal once a successful list shows the workspace is gone; otherwise the request unchanged. */
export function settleBillingRequest(
  request: PlansBillingRequest,
  list: WorkspaceListState
): PlansBillingRequest {
  // Returns the same object when nothing changes so effects can compare by reference.
  return resolveBillingView(request, list).kind === "personal" && request.kind === "workspace"
    ? { kind: "personal" }
    : request;
}
