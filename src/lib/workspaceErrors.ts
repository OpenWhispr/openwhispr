import { CloudApiError, serverRefusalMessage } from "../services/cloudApi";

export type InviteErrorKind =
  | "invalid"
  | "alreadyMember"
  | "alreadyInvited"
  | "seatLimit"
  | "directoryRequired"
  | "notAllowed"
  | "ssoRequired"
  | "refused"
  | "requestFailed";

/** A failed invitation: `refused` carries the server's own reason, every other kind its copy. */
export type InviteFailure =
  { kind: Exclude<InviteErrorKind, "refused"> } | { kind: "refused"; message: string };

const INVITE_ERROR_CODES: Record<string, Exclude<InviteErrorKind, "refused">> = {
  invalid_email: "invalid",
  already_member: "alreadyMember",
  already_invited: "alreadyInvited",
  seat_limit_reached: "seatLimit",
  DIRECTORY_ASSIGNMENT_REQUIRED: "directoryRequired",
  SSO_REQUIRED: "ssoRequired",
};

/**
 * Maps an invitation failure to what the dialog says about it. Codes come first; the message
 * rules are only for API versions that predate them and answer with a status and text alone.
 */
export function classifyInviteError(error: unknown): InviteFailure {
  if (!(error instanceof CloudApiError)) return { kind: "requestFailed" };
  const { code, status, message } = error;

  const byCode = code ? INVITE_ERROR_CODES[code] : undefined;
  if (byCode) return { kind: byCode };

  if (status === 409 && /already a member/i.test(message)) return { kind: "alreadyMember" };
  if (status === 409 && /already pending/i.test(message)) return { kind: "alreadyInvited" };
  if (status === 400 && /invalid email/i.test(message)) return { kind: "invalid" };
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
  | { kind: "refused"; message: string }
  | { kind: "failed" };

/**
 * Maps a failure from acting on a member or invitation row. A 404 for the workspace itself
 * means the caller was removed, which is not the same as the row having disappeared.
 */
export function classifyRowActionError(error: unknown): RowActionError {
  if (error instanceof CloudApiError) {
    if (error.status === 404) {
      return error.message === "Workspace not found" ? { kind: "notAllowed" } : { kind: "gone" };
    }
    if (error.status === 403) return { kind: "notAllowed" };
  }
  const message = serverRefusalMessage(error);
  return message ? { kind: "refused", message } : { kind: "failed" };
}
