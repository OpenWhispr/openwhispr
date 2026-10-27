import {
  classifyInviteError,
  type InviteErrorKind,
  type InviteFailure,
} from "../lib/workspaceErrors";
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
    }
  ): Promise<{ email_sent: boolean }>;
}

export interface InvitePeople {
  sendInvitations(input: {
    workspaceId: string;
    emails: string[];
    role: "admin" | "member";
    teamIds?: string[];
    spaceIds?: string[];
    onResult: (email: string, outcome: InviteOutcome) => void;
  }): Promise<void>;
}

// Outcomes that every remaining address would share, so asking again only adds noise.
function endsTheBatch(kind: InviteErrorKind): boolean {
  return kind === "notAllowed" || kind === "seatLimit" || kind === "ssoRequired";
}

export function createInvitePeople(deps: InvitePeopleDependencies): InvitePeople {
  return {
    async sendInvitations({ workspaceId, emails, role, teamIds, spaceIds, onResult }) {
      let stopped: InviteOutcome | null = null;

      // One request at a time: seat counting and the server's one-pending-invite-per-email
      // index must not race each other.
      for (const email of emails) {
        if (stopped) {
          onResult(email, stopped);
          continue;
        }

        let outcome: InviteOutcome;
        try {
          const result = await deps.send(workspaceId, {
            email,
            role,
            ...(teamIds?.length ? { team_ids: teamIds } : {}),
            ...(spaceIds?.length ? { space_ids: spaceIds } : {}),
          });
          outcome = { ok: true, emailSent: result.email_sent };
        } catch (error) {
          const failure = classifyInviteError(error);
          outcome = { ok: false, ...failure };
          if (endsTheBatch(failure.kind)) stopped = outcome;
        }
        onResult(email, outcome);
      }
    },
  };
}

export const invitePeople = createInvitePeople({ send: InvitationsService.send });
