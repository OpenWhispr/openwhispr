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
