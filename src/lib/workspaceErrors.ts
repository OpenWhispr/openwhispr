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
  | { kind: Exclude<InviteErrorKind, "refused" | "seatLimit" | "rateLimited"> }
  | { kind: "refused"; message: string }
  // `available` is how many addresses fit, when the server said.
  | { kind: "seatLimit"; available?: number }
  // `available` is how many fit right now and `limit` the daily allowance, when the server said.
  | { kind: "rateLimited"; available?: number; limit?: number };

const INVITE_ERROR_CODES: Record<
  string,
  Exclude<InviteErrorKind, "refused" | "seatLimit" | "rateLimited">
> = {
  invalid_email: "invalid",
  already_member: "alreadyMember",
  already_invited: "alreadyInvited",
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
  if (code === "rate_limited") {
    const details = detailsRecord(error.details);
    return typeof details?.available === "number" && typeof details.limit === "number"
      ? { kind: "rateLimited", available: details.available, limit: details.limit }
      : { kind: "rateLimited" };
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
  | { kind: "rateLimited" }
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
    if (error.code === "rate_limited") return { kind: "rateLimited" };
    if (error.status === 404) {
      if (ROW_GONE_MESSAGE.test(error.message)) return { kind: "gone" };
      if (error.message === "Workspace not found") return { kind: "notAllowed" };
    }
    if (error.status === 403) return { kind: "notAllowed" };
  }
  const message = serverRefusalMessage(error);
  return message ? { kind: "refused", message } : { kind: "failed" };
}

export type TeamActionError =
  | { kind: "planRequired" }
  | { kind: "nameTaken" }
  | { kind: "lastAdmin" }
  | { kind: "notWorkspaceMembers"; userIds: string[] }
  | RowActionError;

const TEAM_GONE_MESSAGE = /^team not found$/i;

/** Maps a failed team action; codes come first, then a missing team, then the row action kinds. */
export function classifyTeamError(error: unknown): TeamActionError {
  if (error instanceof CloudApiError) {
    switch (error.code) {
      case "team_plan_required":
        return { kind: "planRequired" };
      case "team_name_taken":
        return { kind: "nameTaken" };
      case "last_team_admin":
        return { kind: "lastAdmin" };
      case "not_workspace_members": {
        const userIds = detailsRecord(error.details)?.user_ids;
        return {
          kind: "notWorkspaceMembers",
          userIds: Array.isArray(userIds)
            ? userIds.filter((id): id is string => typeof id === "string")
            : [],
        };
      }
    }
    if (error.status === 404 && TEAM_GONE_MESSAGE.test(error.message)) return { kind: "gone" };
  }
  return classifyRowActionError(error);
}

export type RemovalError =
  | { kind: "transferRequired"; owners: OwnedMemberContent[] }
  | { kind: "invalidTransferTarget" }
  | { kind: "cannotRemove"; reason: "owner" | "self" }
  | { kind: "directoryManaged"; userIds: string[] }
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
      case "directory_managed": {
        const userIds = detailsRecord(error.details)?.user_ids;
        return {
          kind: "directoryManaged",
          userIds: Array.isArray(userIds)
            ? userIds.filter((id): id is string => typeof id === "string")
            : [],
        };
      }
    }
  }
  return classifyRowActionError(error);
}

export type SpaceActionError =
  | { kind: "nameTaken" }
  | { kind: "lastAdmin" }
  | { kind: "notOpen" }
  // 410: the space was archived, so it no longer takes joins or members.
  | { kind: "archived" }
  | { kind: "notWorkspaceMembers"; userIds: string[] }
  // Teams a create named that were deleted or moved since the list loaded.
  | { kind: "teamsUnavailable"; teamIds: string[] }
  | RowActionError;

/** Maps a failed space action; codes come first, then the row action kinds. */
export function classifySpaceError(error: unknown): SpaceActionError {
  if (error instanceof CloudApiError) {
    switch (error.code) {
      case "space_name_taken":
        return { kind: "nameTaken" };
      case "last_space_admin":
        return { kind: "lastAdmin" };
      case "space_not_open":
        return { kind: "notOpen" };
      case "space_archived":
        return { kind: "archived" };
      case "space_not_found":
        return { kind: "gone" };
      case "not_workspace_members": {
        const userIds = detailsRecord(error.details)?.user_ids;
        return {
          kind: "notWorkspaceMembers",
          userIds: Array.isArray(userIds)
            ? userIds.filter((id): id is string => typeof id === "string")
            : [],
        };
      }
      case "teams_not_available": {
        const teamIds = detailsRecord(error.details)?.team_ids;
        return {
          kind: "teamsUnavailable",
          teamIds: Array.isArray(teamIds)
            ? teamIds.filter((id): id is string => typeof id === "string")
            : [],
        };
      }
    }
  }
  return classifyRowActionError(error);
}

/**
 * The row-action kind a confirm dialog can show for a failed space action. The kinds only a space
 * has (a taken name, the last admin, a closed or archived space) have no screen of their own
 * there, so they read as a plain failure; a team's own kinds read the same way.
 */
export function rowActionErrorOf(
  failure: SpaceActionError | TeamActionError | undefined
): RowActionError {
  switch (failure?.kind) {
    case "gone":
    case "notAllowed":
    case "ssoRequired":
    case "rateLimited":
    case "refused":
    case "failed":
      return failure;
    default:
      return { kind: "failed" };
  }
}
