import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import {
  classifyInviteError,
  type InviteErrorKind,
  type InviteFailure,
} from "../lib/workspaceErrors";
import { CloudApiError } from "./cloudApi";
import { InvitationsService } from "./InvitationsService";

export type InviteOutcome = { ok: true; emailSent: boolean } | ({ ok: false } & InviteFailure);

export interface InvitePeopleDependencies {
  send(
    workspaceId: string,
    input: {
      email: string;
      role: "admin" | "member";
      team_ids?: string[];
      space_ids?: string[];
    },
    authGeneration: number | undefined
  ): Promise<{ email_sent: boolean }>;
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

// Outcomes that every remaining address would share, so asking again only adds noise. Every
// per-address refusal is a 409, so a 400 is about the request itself (its teams or spaces).
function endsTheBatch(kind: InviteErrorKind, error: unknown): boolean {
  return (
    kind === "notAllowed" ||
    kind === "seatLimit" ||
    kind === "ssoRequired" ||
    kind === "sessionExpired" ||
    (kind === "refused" && error instanceof CloudApiError && error.status === 400)
  );
}

export function createInvitePeople(deps: InvitePeopleDependencies): InvitePeople {
  return {
    async sendInvitations({ workspaceId, emails, role, teamIds, spaceIds, onResult, signal }) {
      // Read once: a run that outlives a sign-in change must not continue as the new account.
      const authGeneration = deps.authGeneration();
      let stopped: InviteOutcome | null = null;

      // One request at a time: seat counting and the server's one-pending-invite-per-email
      // index must not race each other.
      for (const email of emails) {
        if (signal?.aborted) return;
        if (stopped) {
          onResult(email, stopped);
          continue;
        }

        let outcome: InviteOutcome;
        try {
          const result = await deps.send(
            workspaceId,
            {
              email,
              role,
              ...(teamIds?.length ? { team_ids: teamIds } : {}),
              ...(spaceIds?.length ? { space_ids: spaceIds } : {}),
            },
            authGeneration
          );
          outcome = { ok: true, emailSent: result.email_sent };
        } catch (error) {
          const failure = classifyInviteError(error);
          outcome = { ok: false, ...failure };
          if (endsTheBatch(failure.kind, error)) stopped = outcome;
        }
        if (signal?.aborted) return;
        onResult(email, outcome);
      }
    },
  };
}

export const invitePeople = createInvitePeople({
  send: InvitationsService.send,
  authGeneration: () => getValidatedAuthGeneration() ?? undefined,
});
