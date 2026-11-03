import { recipientKey, type PickedRecipient } from "./spacePeoplePicker";

/** What one Add members attempt did with each staged recipient. */
export interface AddAttemptOutcome {
  addedMembers: PickedRecipient[];
  failedMembers: PickedRecipient[];
  addedGroups: PickedRecipient[];
  failedGroups: PickedRecipient[];
  invited: PickedRecipient[];
  failedInvites: PickedRecipient[];
  /**
   * Addresses that already had a workspace invitation. The API attaches no teamspace to an
   * existing invitation, so they weren't added, and trying again wouldn't change that.
   */
  skippedInvites: PickedRecipient[];
  /**
   * People the server says are no longer in the workspace. They can't be added, so they are
   * dropped from the selection instead of held for a retry that would be refused again.
   */
  leftMembers: PickedRecipient[];
}

/** What stays staged for Try again: only what failed, in the order picked. */
export function remainingAfter(
  picked: PickedRecipient[],
  outcome: AddAttemptOutcome
): PickedRecipient[] {
  const failed = new Set(
    [...outcome.failedMembers, ...outcome.failedGroups, ...outcome.failedInvites].map(recipientKey)
  );
  return picked.filter((recipient) => failed.has(recipientKey(recipient)));
}

/** Whether anything went, and which line to show. */
export function attemptSummary(outcome: AddAttemptOutcome): {
  kind: "allDone" | "allFailed" | "partial";
} {
  const failed =
    outcome.failedMembers.length + outcome.failedGroups.length + outcome.failedInvites.length;
  const went = outcome.addedMembers.length + outcome.addedGroups.length + outcome.invited.length;
  if (failed === 0) return { kind: "allDone" };
  return { kind: went === 0 ? "allFailed" : "partial" };
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
