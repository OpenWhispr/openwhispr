import { invitePeople } from "../services/invitePeople";

export type InviteTarget = { spaceIds: string[] } | { teamIds: string[] };

export interface InviteRecipient {
  email: string;
  role: "admin" | "member";
}

export interface InviteAfterCreateResult {
  /** Addresses an invitation now exists for, including one that already existed and took the grant. */
  invited: string[];
  /** Addresses the target didn't get, an existing member included. */
  failed: string[];
  /** Invitations made whose email didn't go out. */
  undelivered: number;
}

// The teamspace or team exists by now, so this never throws: whatever goes wrong here is a list of
// people to invite from Members, never a failed create. Every address that didn't come back
// invited counts, an existing member included. A pending invitation counts only when it didn't
// take the target, which is an older API's answer: that person is not in it. One batch per role,
// as the Members panel sends them.
export async function inviteAfterCreate({
  workspaceId,
  target,
  recipients,
}: {
  workspaceId: string;
  target: InviteTarget;
  recipients: InviteRecipient[];
}): Promise<InviteAfterCreateResult> {
  const result: InviteAfterCreateResult = { invited: [], failed: [], undelivered: 0 };
  for (const role of ["member", "admin"] as const) {
    const emails = recipients.filter((recipient) => recipient.role === role).map((r) => r.email);
    if (emails.length === 0) continue;
    const reported = new Set<string>();
    try {
      await invitePeople.sendInvitations({
        workspaceId,
        emails,
        role,
        ...target,
        onResult: (email, outcome) => {
          reported.add(email);
          // `=== true`: src compiles without strictNullChecks, where a bare `ok` doesn't narrow.
          if (outcome.ok === true) {
            result.invited.push(email);
            if (!outcome.emailSent) result.undelivered += 1;
          } else if (outcome.grantsAdded === true) result.invited.push(email);
          else result.failed.push(email);
        },
      });
    } catch {
      // Whatever it didn't get to report is handled below.
    }
    for (const email of emails) if (!reported.has(email)) result.failed.push(email);
  }
  return result;
}
