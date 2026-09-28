/**
 * The translated copy a failed connector action shows, as a key under both
 * `connectors.approval.errors` (the approval card) and
 * `connectors.toolStatus.errors` (the tool step). One mapping for both, so
 * they can't drift. A failed action is one the provider didn't act on, so the
 * copy never says it might have been sent.
 */
export type ConnectorErrorCopyKey =
  | "not_in_channel"
  | "channel_not_found"
  | "is_archived"
  | "reconnect_needed"
  | "connection_changed"
  | "rate_limited"
  | "missing_scope"
  | "msg_too_long"
  | "no_text"
  | "credential_save_failed"
  | "network"
  | "dm_failed"
  | "restricted"
  | "generic"
  // Email drafts fail in a tool step only, never on a card.
  | "open_failed"
  | "draft_too_long"
  | "invalid_address";

const OWN_COPY: ReadonlySet<string> = new Set<ConnectorErrorCopyKey>([
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "reconnect_needed",
  "connection_changed",
  "rate_limited",
  "missing_scope",
  "msg_too_long",
  "no_text",
  "credential_save_failed",
  "open_failed",
  "draft_too_long",
  "invalid_address",
]);

const ALIASES: ReadonlyMap<string, ConnectorErrorCopyKey> = new Map([
  // Slack refused or revoked the login.
  ["invalid_auth", "reconnect_needed"],
  ["account_inactive", "reconnect_needed"],
  ["not_authed", "reconnect_needed"],
  ["token_revoked", "reconnect_needed"],
  ["ratelimited", "rate_limited"],
  ["restricted_action", "restricted"],
  ["restricted_action_read_only_channel", "restricted"],
  ["ekm_access_denied", "restricted"],
  // A request that never left, or a token refresh Slack couldn't answer,
  // before anything was posted.
  ["network_error", "network"],
  ["timeout", "network"],
  ["internal_error", "network"],
  ["service_unavailable", "network"],
  // conversations.open refusals: the DM, and so the message, never opened.
  ["user_not_found", "dm_failed"],
  ["user_not_visible", "dm_failed"],
  ["user_disabled", "dm_failed"],
  ["cannot_dm_bot", "dm_failed"],
  ["not_enough_users", "dm_failed"],
  ["too_many_users", "dm_failed"],
  ["users_list_not_supplied", "dm_failed"],
  ["method_not_supported_for_channel_type", "dm_failed"],
]);

// Transport codes: Node's (ECONNREFUSED, EAI_AGAIN), Chromium's
// (ERR_INTERNET_DISCONNECTED), undici's (UND_ERR_*), and a 5xx. Provider
// codes are lower case, so they never match.
const TRANSPORT_CODE = /^(E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|http_5\d\d)$/;

export function connectorErrorCopyKey(errorCode: string | null | undefined): ConnectorErrorCopyKey {
  if (!errorCode) return "generic";
  if (OWN_COPY.has(errorCode)) return errorCode as ConnectorErrorCopyKey;
  const alias = ALIASES.get(errorCode);
  if (alias) return alias;
  return TRANSPORT_CODE.test(errorCode) ? "network" : "generic";
}
