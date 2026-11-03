import type { Team, WorkspaceMember } from "../types/electron";
import { isValidEmail, parseEmails } from "./inviteFlow";
import { filterMemberCandidates } from "./memberCandidates";

export type PickedRecipient =
  | { kind: "member"; userId: string; label: string; email: string }
  | { kind: "group"; teamId: string; label: string; memberCount: number }
  | { kind: "email"; email: string; role: "admin" | "member"; valid: boolean };

export interface PickerResults {
  members: { member: WorkspaceMember; hasAccess: boolean }[];
  groups: { group: Team; hasAccess: boolean }[];
  /** The query reads as an address and nobody matches: offer to invite. */
  inviteEmail: string | null;
  noResults: boolean;
}

/** The most of each kind the list shows, so a large workspace never renders its whole roster. */
export const PICKER_MAX_PER_KIND = 8;

export function recipientKey(recipient: PickedRecipient): string {
  switch (recipient.kind) {
    case "member":
      return `member:${recipient.userId}`;
    case "group":
      return `group:${recipient.teamId}`;
    case "email":
      return `email:${recipient.email}`;
  }
}

export function memberRecipient(member: WorkspaceMember): PickedRecipient {
  return {
    kind: "member",
    userId: member.user_id,
    label: member.name || member.email,
    email: member.email,
  };
}

export function groupRecipient(group: Team): PickedRecipient {
  return {
    kind: "group",
    teamId: group.id,
    label: group.name,
    memberCount: group.member_count ?? 0,
  };
}

export function emailRecipient(email: string, role: "admin" | "member"): PickedRecipient {
  return { kind: "email", email, role, valid: isValidEmail(email) };
}

export function pickerResults(input: {
  query: string;
  roster: WorkspaceMember[];
  groups: Team[];
  picked: PickedRecipient[];
  /** Rows that already have access show disabled, never pickable. */
  accessUserIds: ReadonlySet<string>;
  accessGroupIds: ReadonlySet<string>;
  /** The creator, who gets a direct admin row anyway. */
  hiddenUserIds?: ReadonlySet<string>;
  canInvite: boolean;
}): PickerResults {
  const { query, roster, groups, picked, accessUserIds, accessGroupIds, hiddenUserIds } = input;
  const pickedKeys = new Set(picked.map(recipientKey));
  const needle = query.trim().toLowerCase();

  // Left out before the cap, so a hidden or picked person never takes one of the eight places.
  const candidates = roster.filter(
    (member) => !hiddenUserIds?.has(member.user_id) && !pickedKeys.has(`member:${member.user_id}`)
  );
  const members = filterMemberCandidates(candidates, needle)
    .slice(0, PICKER_MAX_PER_KIND)
    .map((member) => ({ member, hasAccess: accessUserIds.has(member.user_id) }));

  const matchingGroups = groups
    .filter((group) => !pickedKeys.has(`group:${group.id}`))
    .filter((group) => group.name.toLowerCase().includes(needle))
    .slice(0, PICKER_MAX_PER_KIND)
    .map((group) => ({ group, hasAccess: accessGroupIds.has(group.id) }));

  const typed = query.trim();
  // A roster address is that member, listed above, so it is never someone to invite.
  const inviteEmail =
    input.canInvite &&
    isValidEmail(typed) &&
    !roster.some((member) => member.email?.toLowerCase() === typed.toLowerCase())
      ? typed
      : null;

  return {
    members,
    groups: matchingGroups,
    inviteEmail,
    noResults: members.length === 0 && matchingGroups.length === 0 && inviteEmail === null,
  };
}

/**
 * Adds recipients to the staged ones, each once. An address staged again takes the new role, since
 * the person chose it a second time. Members who already have access, or are hidden, can't be
 * staged by typing their address any more than by picking their row.
 */
export function addRecipients(
  picked: PickedRecipient[],
  incoming: PickedRecipient[],
  skip: { accessUserIds?: ReadonlySet<string>; hiddenUserIds?: ReadonlySet<string> } = {}
): PickedRecipient[] {
  let next = picked;
  for (const recipient of incoming) {
    if (
      recipient.kind === "member" &&
      (skip.accessUserIds?.has(recipient.userId) || skip.hiddenUserIds?.has(recipient.userId))
    ) {
      continue;
    }
    const key = recipientKey(recipient);
    const index = next.findIndex((existing) => recipientKey(existing) === key);
    if (index === -1) {
      next = [...next, recipient];
      continue;
    }
    const existing = next[index];
    if (
      existing.kind === "email" &&
      recipient.kind === "email" &&
      existing.role !== recipient.role
    ) {
      next = next.map((entry, position) => (position === index ? recipient : entry));
    }
  }
  return next;
}

/** Splits pasted text through parseAddressList and returns one recipient per address, members resolved by email. */
export function recipientsFromText(text: string, roster: WorkspaceMember[]): PickedRecipient[] {
  const membersByEmail = new Map<string, WorkspaceMember>();
  for (const member of roster) {
    if (member.email) membersByEmail.set(member.email.toLowerCase(), member);
  }
  const recipients = parseEmails(text).map((address): PickedRecipient => {
    const member = membersByEmail.get(address);
    return member ? memberRecipient(member) : emailRecipient(address, "member");
  });
  return addRecipients([], recipients);
}

export function pickedSummary(picked: PickedRecipient[]): {
  memberIds: string[];
  teamIds: string[];
  emails: { email: string; role: "admin" | "member" }[];
  hasInvalid: boolean;
} {
  const summary = {
    memberIds: [] as string[],
    teamIds: [] as string[],
    emails: [] as { email: string; role: "admin" | "member" }[],
    hasInvalid: false,
  };
  for (const recipient of picked) {
    if (recipient.kind === "member") summary.memberIds.push(recipient.userId);
    else if (recipient.kind === "group") summary.teamIds.push(recipient.teamId);
    // An invalid address blocks the submit; it is never sent as one to invite.
    else if (recipient.valid) summary.emails.push({ email: recipient.email, role: recipient.role });
    else summary.hasInvalid = true;
  }
  return summary;
}
