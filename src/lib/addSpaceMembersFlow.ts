import { isRetryableFailure } from "./inviteFlow";
import { recipientKey, type PickedRecipient } from "./spacePeoplePicker";
import type { InviteFailure, SpaceActionError } from "./workspaceErrors";

/** An address the server turned down for a reason of its own, which the line says. */
export interface InviteRefusal {
  recipient: PickedRecipient;
  failure: InviteFailure;
}

/** What one Add members attempt did with each staged recipient. */
export interface AddAttemptOutcome {
  addedMembers: PickedRecipient[];
  failedMembers: PickedRecipient[];
  addedTeams: PickedRecipient[];
  failedTeams: PickedRecipient[];
  invited: PickedRecipient[];
  /** The invited whose invitation exists but whose email couldn't be delivered. */
  undeliveredInvites: PickedRecipient[];
  // In `invited` too: the invitation they already had took the teamspace, and no email went out.
  pendingInvites: PickedRecipient[];
  failedInvites: PickedRecipient[];
  refusedInvites: InviteRefusal[];
  /**
   * Addresses whose workspace invitation didn't take this teamspace. An older API attaches none
   * to an existing invitation, so they weren't added, and trying again wouldn't change that.
   */
  skippedInvites: PickedRecipient[];
  /**
   * People the server says are no longer in the workspace. They can't be added, so they are
   * dropped from the selection instead of held for a retry that would be refused again.
   */
  leftMembers: PickedRecipient[];
}

// A seat refusal needs the selection trimmed first, so trying again as it stands wouldn't help.
function retriesAsItStands(failure: InviteFailure): boolean {
  return failure.kind !== "seatLimit" && isRetryableFailure(failure);
}

/** How many addresses a seat refusal says would still fit; the rest have to be removed first. */
export function seatRoomLeft(failure: InviteFailure): number {
  return failure.kind === "seatLimit" ? (failure.available ?? 0) : 0;
}

/**
 * What stays staged: what failed, and addresses a second try or a trim can still get through, in
 * the order picked. Any other refusal would only be refused again, so it goes with its line.
 */
export function remainingAfter(
  picked: PickedRecipient[],
  outcome: AddAttemptOutcome
): PickedRecipient[] {
  const kept = outcome.refusedInvites
    .filter(({ failure }) => retriesAsItStands(failure) || seatRoomLeft(failure) > 0)
    .map(({ recipient }) => recipient);
  const failed = new Set(
    [...outcome.failedMembers, ...outcome.failedTeams, ...outcome.failedInvites, ...kept].map(
      recipientKey
    )
  );
  return picked.filter((recipient) => failed.has(recipientKey(recipient)));
}

function hasFailures(outcome: AddAttemptOutcome): boolean {
  return (
    outcome.failedMembers.length + outcome.failedTeams.length + outcome.failedInvites.length > 0
  );
}

/** Whether what stays staged could go through as it is, which is what Try again promises. */
export function canRetry(outcome: AddAttemptOutcome): boolean {
  return (
    hasFailures(outcome) || outcome.refusedInvites.some(({ failure }) => retriesAsItStands(failure))
  );
}

/** Whether anything went, and which line to show. A refusal always says its own line. */
export function attemptSummary(outcome: AddAttemptOutcome): {
  kind: "allDone" | "allFailed" | "partial";
} {
  const went = outcome.addedMembers.length + outcome.addedTeams.length + outcome.invited.length;
  if (!hasFailures(outcome)) return { kind: "allDone" };
  return { kind: went === 0 && outcome.refusedInvites.length === 0 ? "allFailed" : "partial" };
}

/**
 * A write the teamspace itself refused, which no retry changes: it was deleted, the server can't
 * find it for this user, or this user may not manage it (access revoked, a lower role, or company
 * single sign-on). Null means the failure is about this try.
 */
export type SpaceAccessEnd = "deleted" | "gone" | "notAllowed" | "ssoRequired";

export function spaceAccessEnd(failure: SpaceActionError): SpaceAccessEnd | null {
  switch (failure.kind) {
    case "archived":
      return "deleted";
    case "gone":
    case "notAllowed":
    case "ssoRequired":
      return failure.kind;
    default:
      return null;
  }
}

/**
 * An address that answered "already invited" may have been invited by an earlier try of this very
 * Add whose answer was lost, and that invitation carries this teamspace. When the teamspace's own
 * invitations list the address, it was invited, not skipped.
 */
export function settleListedInvites(
  outcome: AddAttemptOutcome,
  listedAddresses: ReadonlySet<string>
): AddAttemptOutcome {
  const isListed = (recipient: PickedRecipient): boolean =>
    recipient.kind === "email" && listedAddresses.has(recipient.email.toLowerCase());
  const listed = outcome.skippedInvites.filter(isListed);
  if (listed.length === 0) return outcome;
  return {
    ...outcome,
    invited: [...outcome.invited, ...listed],
    skippedInvites: outcome.skippedInvites.filter((recipient) => !isListed(recipient)),
  };
}
