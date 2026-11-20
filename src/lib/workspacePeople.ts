import type { Workspace, WorkspaceInvitation, WorkspaceMember } from "../types/electron";
import { workspaceCan } from "./capabilities";
import { hasActiveWorkspaceSubscription, hasSubscription } from "./workspaceBilling";

export type PeopleCount =
  { status: "loading" } | { status: "known"; count: number } | { status: "failed" };

/** Every member (seat-free admins too) plus invitations not accepted, not revoked and not expired. */
export function countPeople(
  members: WorkspaceMember[],
  invitations: Array<Pick<WorkspaceInvitation, "accepted_at" | "revoked_at" | "expires_at">>,
  now: number
): number {
  const liveInvitations = invitations.filter(
    (invitation) =>
      !invitation.accepted_at && !invitation.revoked_at && Date.parse(invitation.expires_at) > now
  );
  return members.length + liveInvitations.length;
}

/** Which buttons a workspace card with no subscription leads with. */
export type FreeWorkspaceCta = "none" | "pending" | "invite" | "upgrade" | "unknown";

type CtaWorkspace = Pick<
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
  if (!people || people.status === "loading") return "pending";
  if (people.status === "failed") return "unknown";
  return people.count <= 1 ? "invite" : "upgrade";
}
