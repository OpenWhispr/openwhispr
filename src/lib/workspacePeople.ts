import type { Workspace, WorkspaceInvitation } from "../types/electron";
import { workspaceCan } from "./capabilities";
import { hasActiveWorkspaceSubscription, hasSubscription } from "./workspaceBilling";

export type PeopleField = number | "loading" | "failed" | null;

export interface PeopleCount {
  members: PeopleField;
  invitations: PeopleField;
}

type WorkspaceListCounts = Pick<Workspace, "member_count" | "invitation_count">;

export function workspacePeopleCounts(
  workspace: WorkspaceListCounts,
  fallback: PeopleCount | null
): PeopleCount {
  return {
    members: workspace.member_count ?? fallback?.members ?? null,
    invitations: workspace.invitation_count ?? fallback?.invitations ?? null,
  };
}

export function countLiveInvitations(
  invitations: Array<Pick<WorkspaceInvitation, "accepted_at" | "revoked_at" | "expires_at">>,
  now: number
): number {
  return invitations.filter(
    (invitation) =>
      !invitation.accepted_at && !invitation.revoked_at && Date.parse(invitation.expires_at) > now
  ).length;
}

/** Which buttons a workspace card with no subscription leads with. */
export type FreeWorkspaceCta = "none" | "pending" | "invite" | "upgrade" | "unknown";

type CtaWorkspace = WorkspaceListCounts &
  Pick<
    Workspace,
    "plan" | "status" | "role" | "capabilities" | "stripe_subscription_id" | "has_subscription"
  >;

export function freeWorkspaceCta(
  workspace: CtaWorkspace,
  people: PeopleCount | null
): FreeWorkspaceCta {
  if (
    !workspaceCan(workspace, "manage_billing") ||
    hasSubscription(workspace) ||
    hasActiveWorkspaceSubscription(workspace)
  ) {
    return "none";
  }
  // Someone who can't invite has only the checkout to offer.
  if (!workspaceCan(workspace, "manage_members")) return "upgrade";
  const { members, invitations } = workspacePeopleCounts(workspace, people);
  if (
    (typeof members === "number" && members >= 2) ||
    (typeof invitations === "number" && invitations >= 2)
  ) {
    return "upgrade";
  }
  if (members === "failed" || invitations === "failed") return "unknown";
  if (typeof members !== "number" || typeof invitations !== "number") return "pending";
  // The roster includes people who do not occupy a paid seat.
  return members + invitations <= 1 ? "invite" : "upgrade";
}
