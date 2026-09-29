const { describeError } = require("./errorSummary");

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_USER_SCOPES = [
  "chat:write",
  "channels:read",
  "groups:read",
  "im:write",
  "users:read",
  "users:read.email",
];
const EXPIRY_SKEW_MS = 60 * 1000;
// PKCE apps get refresh tokens that expire 30 days after they are issued.
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Slack only distributes apps whose redirect URLs are HTTPS, so it redirects
// to the openwhispr.com relay, which forwards to this loopback server by the
// port in state (spec §7.2). A first Slack sign-in (workspace choice, 2FA)
// can outlast the calendars' 120 s, so the flow waits 5 minutes.
const SLACK_RELAY_REDIRECT_URI = "https://openwhispr.com/auth/slack/callback";
const SLACK_LOOPBACK = { ports: [0], callbackPath: "/slack/callback", timeoutMs: 5 * 60 * 1000 };

// SLACK_OAUTH_REDIRECT_URI points a dev build at a website preview of the
// relay. Only an https: URL is accepted; anything else uses the real relay.
function slackRedirectUri(env) {
  const override = env?.SLACK_OAUTH_REDIRECT_URI;
  if (typeof override !== "string" || !override) return SLACK_RELAY_REDIRECT_URI;
  try {
    return new URL(override).protocol === "https:" ? override : SLACK_RELAY_REDIRECT_URI;
  } catch {
    return SLACK_RELAY_REDIRECT_URI;
  }
}
// oauth.v2.access errors that mean the login itself is gone. Rate limits,
// service_unavailable, internal_error and every other error keep the login:
// the next attempt may work, and a false "reconnect" disconnects the user.
const OAUTH_LOGIN_GONE = new Set([
  "invalid_refresh_token",
  "token_revoked",
  "token_expired",
  "invalid_auth",
  "account_inactive",
  "invalid_client_id",
  "access_denied",
  "team_access_not_granted",
  "not_allowed_token_type",
  "pkce_not_allowed",
]);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

// The code exchange nests the user token under authed_user; a refresh
// returns it at the top level (both recorded in plan Task 3).
function parseUserTokens(data, now) {
  const source = typeof data?.authed_user?.access_token === "string" ? data.authed_user : data;
  if (typeof source?.access_token !== "string") return null;
  if (source.token_type !== undefined && source.token_type !== "user") return null;
  return {
    accessToken: source.access_token,
    refreshToken: typeof source.refresh_token === "string" ? source.refresh_token : null,
    expiresAt: Number.isFinite(source.expires_in) ? now + source.expires_in * 1000 : null,
  };
}

// Only the login a pending action was approved under may act for it.
function sameLogin(entry, binding) {
  return Boolean(
    entry &&
    binding &&
    entry.generation === binding.generation &&
    entry.credential.userId === binding.accountId &&
    entry.credential.teamId === binding.workspaceId
  );
}

function createSlackAuth({
  api,
  credentials,
  getClientId,
  runOAuthLoopbackFlow,
  OAuthFlowError,
  loopback = SLACK_LOOPBACK,
  redirectUri = slackRedirectUri(process.env),
  renderResultPage = null,
  // Optional: told about a credential write that failed for a reason other
  // than a reconnect/disconnect race (disk, permission, encryption errors
  // from credentialStore) via logger.warn(message, describeError(error),
  // area). Never a token or a raw error.message.
  logger = null,
  now = Date.now,
}) {
  const refreshes = new Map();

  // `signal` gives the sign-in up when a newer Connect replaces it.
  function authorize({ signal } = {}) {
    const clientId = getClientId();
    // Fail before opening a browser on a client_id-less URL.
    if (!clientId) return Promise.reject(codedError("not_configured"));
    return runOAuthLoopbackFlow({
      errorParam: "slack_error",
      ...loopback,
      publicRedirectUri: redirectUri,
      renderResultPage,
      signal,
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: clientId,
          user_scope: SLACK_USER_SCOPES.join(","),
          redirect_uri: redirectUri,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const exchanged = await api.call("oauth.v2.access", {
          client_id: clientId,
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        });
        const tokens = exchanged.ok ? parseUserTokens(exchanged.data, now()) : null;
        if (!tokens)
          throw new OAuthFlowError("token_exchange_failed", "slack_token_exchange_failed");
        const identity = await api.call("auth.test", {}, { token: tokens.accessToken });
        if (!identity.ok)
          throw new OAuthFlowError("token_exchange_failed", "slack_identity_failed");
        return {
          ...tokens,
          refreshIssuedAt: tokens.refreshToken ? now() : null,
          userId: identity.data.user_id,
          userName: identity.data.user,
          teamId: identity.data.team_id,
          teamName: identity.data.team,
          teamUrl: identity.data.url,
          needsReconnect: false,
        };
      },
    });
  }

  // Flags the login the binding names, and only it, as needing a reconnect:
  // Slack said that login is gone. A reconnect or disconnect that landed
  // first wins, and nothing is written to it.
  function markReconnect(binding) {
    const entry = credentials.read(binding?.ownerAccountId ?? null, "slack");
    if (!sameLogin(entry, binding)) return { ok: false, errorCode: "connection_changed" };
    try {
      credentials.save(
        binding.ownerAccountId,
        "slack",
        { ...entry.credential, needsReconnect: true },
        binding.generation
      );
    } catch (error) {
      if (error.code === "connection_changed" || error.code === "signed_out") {
        return { ok: false, errorCode: "connection_changed" };
      }
      // A real write failure (disk, permission, encryption). Slack's answer
      // still stands: the login is gone, though the flag wasn't recorded.
      logger?.warn("slack reconnect flag save failed", describeError(error), "connectors");
    }
    return { ok: false, errorCode: "reconnect_needed" };
  }

  function callRefresh(refreshToken) {
    return api.call("oauth.v2.access", {
      client_id: getClientId() ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  async function refresh(binding, credential) {
    if (!credential.refreshToken) return markReconnect(binding);
    let result = await callRefresh(credential.refreshToken);
    // No clear answer: Slack may have rotated the token anyway. The used
    // refresh token still works for a short grace period, so ask once more.
    if (!result.ok && result.outcome === "unknown" && !OAUTH_LOGIN_GONE.has(result.errorCode)) {
      result = await callRefresh(credential.refreshToken);
    }
    if (!result.ok) {
      // A reconnect or disconnect may have landed while the network call was
      // in flight. That always wins over the login this refresh started
      // with: report connection_changed and write nothing for either the
      // login-gone or the transient case.
      if (!sameLogin(credentials.read(binding.ownerAccountId, "slack"), binding)) {
        return { ok: false, errorCode: "connection_changed" };
      }
      return OAUTH_LOGIN_GONE.has(result.errorCode)
        ? markReconnect(binding)
        : { ok: false, errorCode: result.errorCode };
    }
    const tokens = parseUserTokens(result.data, now());
    if (!tokens) return { ok: false, errorCode: "bad_response" };
    const next = {
      ...credential,
      ...tokens,
      refreshToken: tokens.refreshToken ?? credential.refreshToken,
      refreshIssuedAt: tokens.refreshToken ? now() : credential.refreshIssuedAt,
      needsReconnect: false,
    };
    // Saved before use, and only into the slot and generation this refresh
    // started from: a reconnect or disconnect that landed meanwhile wins.
    try {
      credentials.save(binding.ownerAccountId, "slack", next, binding.generation);
    } catch (error) {
      if (error.code === "connection_changed" || error.code === "signed_out") {
        return { ok: false, errorCode: "connection_changed" };
      }
      // A real write failure (disk, permission, encryption): the rotated
      // token is lost, so this is worth a log line, never the token itself.
      logger?.warn("slack token save failed", describeError(error), "connectors");
      return { ok: false, errorCode: "credential_save_failed" };
    }
    return { ok: true, token: next.accessToken, credential: next };
  }

  async function getAccessToken(binding, { forceRefresh = false } = {}) {
    const entry = credentials.read(binding?.ownerAccountId ?? null, "slack");
    if (!sameLogin(entry, binding)) return { ok: false, errorCode: "connection_changed" };
    const { credential } = entry;
    if (credential.needsReconnect) return { ok: false, errorCode: "reconnect_needed" };
    const fresh = !credential.expiresAt || credential.expiresAt - EXPIRY_SKEW_MS > now();
    if (fresh && !forceRefresh) return { ok: true, token: credential.accessToken, credential };
    // Refresh tokens are single-use, so concurrent callers for one login
    // share one refresh.
    const key = `${binding.ownerAccountId}:${binding.generation}`;
    let pending = refreshes.get(key);
    if (!pending) {
      pending = refresh(binding, credential).finally(() => refreshes.delete(key));
      refreshes.set(key, pending);
    }
    return pending;
  }

  // With token rotation, auth.revoke revokes only the token it is given, so
  // the refresh token and the access token are revoked separately. Best
  // effort: the local login is deleted whatever Slack answers.
  async function revoke(credential) {
    for (const token of [credential?.refreshToken, credential?.accessToken]) {
      if (typeof token === "string" && token) await api.call("auth.revoke", {}, { token });
    }
  }

  function statusOf(credential) {
    const refreshExpired = Boolean(
      credential.refreshToken &&
      credential.refreshIssuedAt &&
      now() - credential.refreshIssuedAt > REFRESH_TOKEN_TTL_MS
    );
    return {
      connected: true,
      accountLabel: credential.userName ?? null,
      workspaceLabel: credential.teamName ?? null,
      needsReconnect: Boolean(credential.needsReconnect) || refreshExpired,
    };
  }

  return { authorize, getAccessToken, markReconnect, revoke, statusOf };
}

module.exports = {
  createSlackAuth,
  SLACK_USER_SCOPES,
  SLACK_LOOPBACK,
  SLACK_RELAY_REDIRECT_URI,
  slackRedirectUri,
  OAUTH_LOGIN_GONE,
};
