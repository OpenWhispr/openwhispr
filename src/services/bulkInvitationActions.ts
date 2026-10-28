import { getValidatedAuthGeneration } from "../lib/authRequestContext";
import { classifyRowActionError, type RowActionError } from "../lib/workspaceErrors";
import { CloudApiError } from "./cloudApi";
import { InvitationsService } from "./InvitationsService";

export interface BulkInvitationOutcome {
  /** Ids resent or canceled. */
  done: string[];
  /** Resent, but the email was not delivered (a subset of `done`). */
  noEmail: string[];
  failed: Array<{ id: string; error: RowActionError }>;
}

export interface BulkInvitationDependencies {
  resend(workspaceId: string, invitationId: string): Promise<{ email_sent: boolean }>;
  revoke(workspaceId: string, invitationId: string): Promise<void>;
  /** Read once per run; a run that outlives a sign-in change stops instead of continuing. */
  authGeneration?(): number | undefined;
}

export interface BulkInvitationActions {
  resendInvitations(
    workspaceId: string,
    ids: string[],
    signal?: AbortSignal
  ): Promise<BulkInvitationOutcome>;
  cancelInvitations(
    workspaceId: string,
    ids: string[],
    signal?: AbortSignal
  ): Promise<BulkInvitationOutcome>;
}

// Answers every remaining invitation would share, so asking again only adds noise.
function endsTheRun(error: unknown, classified: RowActionError): boolean {
  return (
    classified.kind === "notAllowed" ||
    classified.kind === "ssoRequired" ||
    (error instanceof CloudApiError && error.status === 429)
  );
}

// Nothing is known about an invitation the run never asked for, so it can be tried again.
const SESSION_CHANGED: RowActionError = { kind: "failed" };

export function createBulkInvitationActions(
  deps: BulkInvitationDependencies
): BulkInvitationActions {
  async function run(
    ids: string[],
    signal: AbortSignal | undefined,
    // Resolves false when the invitation was acted on but its email was not delivered.
    perform: (id: string) => Promise<boolean>,
    // Canceling wants the invitation to stop being pending, which "gone" already says.
    goneIsDone: boolean
  ): Promise<BulkInvitationOutcome> {
    const outcome: BulkInvitationOutcome = { done: [], noEmail: [], failed: [] };
    const authGeneration = deps.authGeneration?.();
    let stopped: RowActionError | null = null;

    // One request at a time: the server rate-limits per workspace, and a refusal that ends the
    // run must not leave later requests already in flight.
    for (const id of ids) {
      if (signal?.aborted) break;
      if (!stopped && deps.authGeneration?.() !== authGeneration) stopped = SESSION_CHANGED;
      if (stopped) {
        outcome.failed.push({ id, error: stopped });
        continue;
      }
      try {
        const delivered = await perform(id);
        outcome.done.push(id);
        if (!delivered) outcome.noEmail.push(id);
      } catch (error) {
        const classified = classifyRowActionError(error);
        if (goneIsDone && classified.kind === "gone") {
          outcome.done.push(id);
          continue;
        }
        outcome.failed.push({ id, error: classified });
        if (endsTheRun(error, classified)) stopped = classified;
      }
    }
    return outcome;
  }

  return {
    resendInvitations: (workspaceId, ids, signal) =>
      run(ids, signal, async (id) => (await deps.resend(workspaceId, id)).email_sent, false),
    cancelInvitations: (workspaceId, ids, signal) =>
      run(
        ids,
        signal,
        async (id) => {
          await deps.revoke(workspaceId, id);
          return true;
        },
        true
      ),
  };
}

export const bulkInvitationActions = createBulkInvitationActions({
  resend: InvitationsService.resend,
  revoke: InvitationsService.revoke,
  authGeneration: () => getValidatedAuthGeneration() ?? undefined,
});
