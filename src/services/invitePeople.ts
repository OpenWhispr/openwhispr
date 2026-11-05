import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { classifyInviteError, type InviteFailure } from "../lib/workspaceErrors";
import { InvitationsService } from "./InvitationsService";
import type { InvitationBatchResult, InvitationBatchStatus } from "../types/electron";

export type InviteOutcome = { ok: true; emailSent: boolean } | ({ ok: false } & InviteFailure);

export interface InvitePeopleDependencies {
  sendBatch(
    workspaceId: string,
    input: {
      emails: string[];
      role: "admin" | "member";
      team_ids?: string[];
      space_ids?: string[];
    },
    authGeneration: number | undefined
  ): Promise<InvitationBatchResult>;
  authGeneration(): number | undefined;
}

export interface InvitePeople {
  sendInvitations(input: {
    workspaceId: string;
    emails: string[];
    role: "admin" | "member";
    teamIds?: string[];
    spaceIds?: string[];
    onResult: (email: string, outcome: InviteOutcome) => void;
    /** Set once the dialog goes away; nothing is reported after it. */
    signal?: AbortSignal;
  }): Promise<void>;
}

const SKIPPED_OUTCOMES: Record<Exclude<InvitationBatchStatus, "invited">, InviteOutcome> = {
  invalid_email: { ok: false, kind: "invalid" },
  already_member: { ok: false, kind: "alreadyMember" },
  already_invited: { ok: false, kind: "alreadyInvited" },
  directory_required: { ok: false, kind: "directoryRequired" },
};

// An address the answer leaves out was not processed, so it can be sent again.
const MISSING_OUTCOME: InviteOutcome = { ok: false, kind: "requestFailed" };

function outcomesByEmail(answer: InvitationBatchResult): Map<string, InviteOutcome> {
  const outcomes = new Map<string, InviteOutcome>();
  for (const { email, status, email_sent } of answer.results) {
    outcomes.set(
      email.toLowerCase(),
      status === "invited" ? { ok: true, emailSent: email_sent === true } : SKIPPED_OUTCOMES[status]
    );
  }
  return outcomes;
}

export function createInvitePeople(deps: InvitePeopleDependencies): InvitePeople {
  return {
    async sendInvitations({ workspaceId, emails, role, teamIds, spaceIds, onResult, signal }) {
      // Read once: a run that outlives a sign-in change must not continue as the new account.
      const authGeneration = deps.authGeneration();
      if (signal?.aborted) return;

      let outcomes: Map<string, InviteOutcome> | null = null;
      let failure: InviteOutcome = MISSING_OUTCOME;
      try {
        const answer = await deps.sendBatch(
          workspaceId,
          {
            emails,
            role,
            ...(teamIds?.length ? { team_ids: teamIds } : {}),
            ...(spaceIds?.length ? { space_ids: spaceIds } : {}),
          },
          authGeneration
        );
        outcomes = outcomesByEmail(answer);
      } catch (error) {
        failure = { ok: false, ...classifyInviteError(error) };
      }
      if (signal?.aborted) return;
      for (const email of emails) {
        onResult(email, outcomes?.get(email.toLowerCase()) ?? failure);
      }
    },
  };
}

export const invitePeople = createInvitePeople({
  sendBatch: InvitationsService.sendBatch,
  authGeneration: () => getValidatedAuthGeneration() ?? undefined,
});
