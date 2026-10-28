import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { MAX_INVITE_RECIPIENTS } from "../lib/inviteFlow";
import {
  classifyInviteError,
  type InviteErrorKind,
  type InviteFailure,
} from "../lib/workspaceErrors";
import { CloudApiError } from "./cloudApi";
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
    /** Stops the run before its next request; nothing is reported for the addresses left. */
    signal?: AbortSignal;
  }): Promise<void>;
}

// Outcomes that every remaining address would share, so asking again only adds noise. Answers
// about one address arrive in the 200's results, so a 400 is about the request itself (its teams,
// spaces or seats).
function endsTheBatch(kind: InviteErrorKind, error: unknown): boolean {
  return (
    kind === "notAllowed" ||
    kind === "seatLimit" ||
    kind === "ssoRequired" ||
    kind === "sessionExpired" ||
    kind === "rateLimited" ||
    (kind === "refused" && error instanceof CloudApiError && error.status === 400)
  );
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

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

export function createInvitePeople(deps: InvitePeopleDependencies): InvitePeople {
  return {
    async sendInvitations({ workspaceId, emails, role, teamIds, spaceIds, onResult, signal }) {
      // Read once: a run that outlives a sign-in change must not continue as the new account.
      const authGeneration = deps.authGeneration();
      let stopped: InviteOutcome | null = null;

      // A throwing listener must not abandon the addresses after it.
      const report = (email: string, outcome: InviteOutcome): void => {
        try {
          onResult(email, outcome);
        } catch {
          // The caller's own state update failed; the remaining addresses still need theirs.
        }
      };

      // One request at a time: seat counting must not race between chunks.
      for (const chunk of chunked(emails, MAX_INVITE_RECIPIENTS)) {
        if (signal?.aborted) return;
        if (stopped) {
          for (const email of chunk) report(email, stopped);
          continue;
        }

        let outcomes: Map<string, InviteOutcome> | null = null;
        let failure: InviteOutcome = MISSING_OUTCOME;
        try {
          const answer = await deps.sendBatch(
            workspaceId,
            {
              emails: chunk,
              role,
              ...(teamIds?.length ? { team_ids: teamIds } : {}),
              ...(spaceIds?.length ? { space_ids: spaceIds } : {}),
            },
            authGeneration
          );
          outcomes = outcomesByEmail(answer);
        } catch (error) {
          const classified = classifyInviteError(error);
          failure = { ok: false, ...classified };
          if (endsTheBatch(classified.kind, error)) stopped = failure;
        }
        if (signal?.aborted) return;
        for (const email of chunk) {
          report(email, outcomes?.get(email.toLowerCase()) ?? failure);
        }
      }
    },
  };
}

export const invitePeople = createInvitePeople({
  sendBatch: InvitationsService.sendBatch,
  authGeneration: () => getValidatedAuthGeneration() ?? undefined,
});
