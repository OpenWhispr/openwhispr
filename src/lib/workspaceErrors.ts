import { CloudApiError, serverRefusalMessage } from "../services/cloudApi";
import type { OwnedMemberContent } from "../types/electron";

export type InviteErrorKind =
  | "invalid"
  | "alreadyMember"
  | "alreadyInvited"
  | "seatLimit"
  | "directoryRequired"
  | "notAllowed"
  | "ssoRequired"
  | "sessionExpired"
  | "rateLimited"
  | "refused"
  | "requestFailed";

/** A failed invitation: `refused` carries the server's own reason, every other kind its copy. */
export type InviteFailure =
  | { kind: Exclude<InviteErrorKind, "refused" | "seatLimit"> }
  | { kind: "refused"; message: string }
  // `available` is how many addresses fit, when the server said.
  | { kind: "seatLimit"; available?: number };

const INVITE_ERROR_CODES: Record<string, Exclude<InviteErrorKind, "refused" | "seatLimit">> = {
  invalid_email: "invalid",
  already_member: "alreadyMember",
  already_invited: "alreadyInvited",
  rate_limited: "rateLimited",
  DIRECTORY_ASSIGNMENT_REQUIRED: "directoryRequired",
  SSO_REQUIRED: "ssoRequired",
  // Main's codes for a session that expired or was replaced by another account's.
  AUTH_EXPIRED: "sessionExpired",
  AUTH_CONTEXT_CHANGED: "sessionExpired",
  AUTH_CONTEXT_UNVALIDATED: "sessionExpired",
};

function detailsRecord(details: unknown): Record<string, unknown> | null {
  return typeof details === "object" && details !== null
    ? (details as Record<string, unknown>)
    : null;
}

/**
 * Maps an invitation failure to what the dialog says about it. Codes come first; the message
 * rules are only for API versions that predate them and answer with a status and text alone.
 */
export function classifyInviteError(error: unknown): InviteFailure {
  if (!(error instanceof CloudApiError)) return { kind: "requestFailed" };
  const { code, status, message } = error;

  if (code === "seat_limit_reached") {
    const available = detailsRecord(error.details)?.available;
    return typeof available === "number" ? { kind: "seatLimit", available } : { kind: "seatLimit" };
  }
  const byCode = code ? INVITE_ERROR_CODES[code] : undefined;
  if (byCode) return { kind: byCode };

  if (status === 409 && /already a member/i.test(message)) return { kind: "alreadyMember" };
  if (status === 409 && /already pending/i.test(message)) return { kind: "alreadyInvited" };
  if (status === 400 && /invalid email/i.test(message)) return { kind: "invalid" };
  if (status === 401) return { kind: "sessionExpired" };
  // The API's text for these ("Insufficient role", "Workspace not found") says less than the
  // copy does, and every remaining address would get the same answer.
  if (status === 403 || status === 404) return { kind: "notAllowed" };
  const refusal = serverRefusalMessage(error);
  if (refusal) return { kind: "refused", message: refusal };
  return { kind: "requestFailed" };
}

export type RowActionError =
  | { kind: "gone" }
  | { kind: "notAllowed" }
  | { kind: "ssoRequired" }
  | { kind: "refused"; message: string }
  | { kind: "failed" };

// The API's answers when the member or invitation itself is missing. Anything else at 404 (the
// workspace, or a bare status the main process filled in) proves nothing about the row.
const ROW_GONE_MESSAGE = /^(member|invitation) not found$/i;

/**
 * Maps a failure from acting on a member or invitation row. A 404 for the workspace itself
 * means the caller was removed, which is not the same as the row having disappeared.
 */
export function classifyRowActionError(error: unknown): RowActionError {
  if (error instanceof CloudApiError) {
    if (error.code === "SSO_REQUIRED") return { kind: "ssoRequired" };
    if (error.status === 404) {
      if (ROW_GONE_MESSAGE.test(error.message)) return { kind: "gone" };
      if (error.message === "Workspace not found") return { kind: "notAllowed" };
    }
    if (error.status === 403) return { kind: "notAllowed" };
  }
  const message = serverRefusalMessage(error);
  return message ? { kind: "refused", message } : { kind: "failed" };
}

export type RemovalError =
  | { kind: "transferRequired"; owners: OwnedMemberContent[] }
  | { kind: "invalidTransferTarget" }
  | { kind: "cannotRemove"; reason: "owner" | "self" }
  | RowActionError;

/** Maps a failed bulk removal; codes come first, then the row action kinds. */
export function classifyRemovalError(error: unknown): RemovalError {
  if (error instanceof CloudApiError) {
    switch (error.code) {
      case "transfer_required": {
        // Without a readable list the dialog still has to ask who takes over.
        const members = detailsRecord(error.details)?.members;
        return { kind: "transferRequired", owners: Array.isArray(members) ? members : [] };
      }
      case "invalid_transfer_target":
        return { kind: "invalidTransferTarget" };
      case "cannot_remove_owner":
        return { kind: "cannotRemove", reason: "owner" };
      case "cannot_remove_self":
        return { kind: "cannotRemove", reason: "self" };
    }
  }
  return classifyRowActionError(error);
}
