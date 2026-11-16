// Linear login and tokens (Linear spec §5.1). PKCE with no client secret,
// over the local loopback server; a refresh only ever reads, refreshes or
// flags the one login an action is bound to (createBoundLogin).
//
// Every value marked "Checked live" was confirmed against a real Linear
// workspace; each lives in one constant.
const { describeError } = require("./errorSummary");
const { createBoundLogin } = require("./boundLogin");
const { LINEAR_AUTHORIZE_URL } = require("./linearApi");

// Least privilege (spec §2): read, create issues, create comments. Never
// `write` or `admin`. The authorize URL takes this comma-separated list,
// which Linear accepted; Linear's token response returns scope as a
// space-separated string instead, which grantedScopes() handles.
const LINEAR_REQUIRED_SCOPES = ["read", "issues:create", "comments:create"];
const LINEAR_SCOPES = LINEAR_REQUIRED_SCOPES.join(",");
// The loopback server listens on a random port, and Linear can't be
// registered for it (a registered redirect URI must match exactly, port
// included), so buildLinearConnector passes the relay as `redirectUri`.
// A first sign-in (workspace choice, 2FA) can outlast the
// calendars' 120 s, so the flow waits 5 minutes.
const LINEAR_LOOPBACK = {
  ports: [0],
  callbackPath: "/linear/callback",
  timeoutMs: 5 * 60 * 1000,
};

// Checked live: Linear matches a registered
// redirect URI exactly, port included, so the loopback server's random port
// can't be registered. Linear redirects to the openwhispr.com relay instead,
// which forwards the browser to the loopback server by the port in state
// (connector spec §7.2, as for Slack).
const LINEAR_RELAY_REDIRECT_URI = "https://openwhispr.com/auth/linear/callback";

// LINEAR_OAUTH_REDIRECT_URI points a dev build at a website preview of the
// relay. Only an https: URL is accepted; anything else uses the real relay.
function linearRedirectUri(env) {
  const override = env?.LINEAR_OAUTH_REDIRECT_URI;
  if (typeof override !== "string" || !override) return LINEAR_RELAY_REDIRECT_URI;
  try {
    return new URL(override).protocol === "https:" ? override : LINEAR_RELAY_REDIRECT_URI;
  } catch {
    return LINEAR_RELAY_REDIRECT_URI;
  }
}
// Checked live: `prompt=consent` shows Linear's consent screen every time, so the
// user picks the workspace instead of reusing the last one silently.
const AUTHORIZE_PARAMS = { response_type: "code", prompt: "consent" };
// Refreshing 5 minutes early keeps an action from starting with a token that
// expires on the way.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// The one token-endpoint error that means the login itself is gone (the app
// was revoked in Linear, or the refresh token expired). Every other error
// keeps the login.
const OAUTH_LOGIN_GONE = new Set(["invalid_grant"]);
// Linear refused the OAuth client, or the build has none: a configuration
// fault, not the user's login, and signing in again won't help.
const CLIENT_REFUSED = new Set(["invalid_client", "unauthorized_client", "not_configured"]);
// The OAuth errors (RFC 6749 §5.2 and §4.1.2.1) that mean "ask again later",
// even when they arrive with a 4xx.
const TRANSIENT_OAUTH_ERRORS = new Set(["temporarily_unavailable", "server_error"]);
// Who signed in, and to which workspace.
const IDENTITY_QUERY =
  "query LinearIdentity { viewer { id name } organization { id name urlKey } }";

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Checked live: `scope` arrives as an array or as a comma- or
// space-separated string. Missing means Linear didn't say (null).
function grantedScopes(scope) {
  if (Array.isArray(scope)) return scope.filter(nonEmptyString);
  if (typeof scope === "string") return scope.split(/[\s,]+/).filter(Boolean);
  return null;
}

// Without expires_in the token is treated as long-lived (expiresAt null):
// a 401 still makes the connector refresh it (forceRefresh).
function parseTokens(data, at) {
  if (!nonEmptyString(data?.access_token)) return null;
  const scopes = grantedScopes(data.scope);
  return {
    accessToken: data.access_token,
    refreshToken: nonEmptyString(data.refresh_token) ? data.refresh_token : null,
    expiresAt: Number.isFinite(data.expires_in) ? at + data.expires_in * 1000 : null,
    scopes,
  };
}

function identityOf(data) {
  const viewer = data?.viewer;
  const organization = data?.organization;
  if (
    !nonEmptyString(viewer?.id) ||
    !nonEmptyString(organization?.id) ||
    !nonEmptyString(organization?.urlKey)
  ) {
    return null;
  }
  return {
    userId: viewer.id,
    userName: nonEmptyString(viewer.name) ? viewer.name : null,
    organizationId: organization.id,
    organizationName: nonEmptyString(organization.name) ? organization.name : null,
    organizationUrlKey: organization.urlKey,
  };
}

// Only the login a pending action was approved under may act for it.
function sameLogin(entry, binding) {
  return Boolean(
    entry &&
    binding &&
    entry.generation === binding.generation &&
    entry.credential.userId === binding.accountId &&
    entry.credential.organizationId === binding.workspaceId
  );
}

function createLinearAuth({
  api,
  credentials,
  getClientId,
  runOAuthLoopbackFlow,
  OAuthFlowError,
  loopback = LINEAR_LOOPBACK,
  // An https relay URL, or null to redirect to the loopback.
  redirectUri = null,
  renderResultPage = null,
  // Optional: told about failures worth a log line via
  // logger.warn(message, { errorName, errorCode }, area). Never a token,
  // a name or a raw error.message.
  logger = null,
  now = Date.now,
}) {
  function clientId() {
    const value = getClientId();
    return nonEmptyString(value) ? value : null;
  }

  function isConfigured() {
    return clientId() !== null;
  }

  // Best effort, both tokens at once so neither waits on the other under
  // the manager's revoke deadline: the refresh token ends the grant, and the
  // access token is revoked too in case Linear only ends the token it gets.
  // revokeToken (linearApi.js) never throws, but the try/catch stays as a
  // last line of defense; either way a failed revoke is logged, by kind
  // only, never the token.
  async function revokeTokens(tokens) {
    await Promise.all(
      tokens
        .filter(({ token }) => nonEmptyString(token))
        .map(async ({ kind, token }) => {
          try {
            const result = await api.revokeToken(token);
            if (!result.ok) {
              logger?.warn("linear revoke failed", { tokenKind: kind }, "connectors");
            }
          } catch (error) {
            logger?.warn(
              "linear revoke failed",
              { tokenKind: kind, ...describeError(error) },
              "connectors"
            );
          }
        })
    );
  }

  // `signal` gives the sign-in up when a newer Connect replaces it. The
  // credential is returned, never saved here: the connector manager saves
  // it under the account and generation that started the Connect.
  function authorize({ signal } = {}) {
    const id = clientId();
    // Fail before opening a browser on a client_id-less URL.
    if (!id) return Promise.reject(codedError("not_configured"));
    return runOAuthLoopbackFlow({
      errorParam: "linear_error",
      ...loopback,
      publicRedirectUri: redirectUri,
      renderResultPage,
      signal,
      buildAuthUrl: (callbackUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: id,
          redirect_uri: callbackUri,
          ...AUTHORIZE_PARAMS,
          scope: LINEAR_SCOPES,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
      },
      handleCallback: async (code, callbackUri, codeVerifier) => {
        const exchanged = await api.exchangeToken({
          code,
          client_id: id,
          redirect_uri: callbackUri,
          code_verifier: codeVerifier,
        });
        if (!exchanged.ok) {
          throw new OAuthFlowError("token_exchange_failed", "linear_token_exchange_failed");
        }
        const data = exchanged.data ?? {};
        // A grant Linear issued that can't become a login is revoked at once,
        // not left live with nothing using it.
        const refuse = async (redirectCode, reason) => {
          await revokeTokens([
            { kind: "refresh", token: data.refresh_token },
            { kind: "access", token: data.access_token },
          ]);
          return new OAuthFlowError(redirectCode, `linear_${reason}`);
        };
        const tokens = parseTokens(data, now());
        if (!tokens) throw await refuse("token_exchange_failed", "token_exchange_failed");
        // Checked only when Linear reports what it granted.
        if (
          tokens.scopes &&
          !LINEAR_REQUIRED_SCOPES.every((scope) => tokens.scopes.includes(scope))
        ) {
          throw await refuse("permission_not_granted", "permission_not_granted");
        }
        const identity = await api.graphql(IDENTITY_QUERY, {}, { token: tokens.accessToken });
        const who = identity.ok ? identityOf(identity.data) : null;
        if (!who) throw await refuse("token_exchange_failed", "identity_failed");
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          ...who,
          scope: tokens.scopes ? tokens.scopes.join(",") : LINEAR_SCOPES,
          needsReconnect: false,
        };
      },
    });
  }

  async function requestRefresh(refreshToken) {
    const id = clientId();
    if (!id) return { ok: false, errorCode: "not_configured" };
    const result = await api.refreshToken({ client_id: id, refresh_token: refreshToken });
    if (!result.ok) {
      return {
        ok: false,
        errorCode: result.errorCode,
        refused: result.refused === true && !TRANSIENT_OAUTH_ERRORS.has(result.errorCode),
      };
    }
    const tokens = parseTokens(result.data, now());
    return tokens ? { ok: true, tokens } : { ok: false, errorCode: "bad_response" };
  }

  // Transient: a network failure, a 5xx, an unreadable answer, a 4xx with no
  // OAuth error. Anything Linear answered with an OAuth error is a verdict.
  const isTransient = (result) =>
    !result.refused &&
    !CLIENT_REFUSED.has(result.errorCode) &&
    !OAUTH_LOGIN_GONE.has(result.errorCode);

  async function refresh(binding, credential) {
    if (!credential.refreshToken) return login.markReconnect(binding);
    let result = await requestRefresh(credential.refreshToken);
    // Asked once more, but only while the login this refresh started with
    // still holds. Checked live: Linear rotates the refresh
    // token on every use; its docs describe a 30-minute grace period on the
    // previous token, so retrying with the same one after a lost answer is
    // expected to still work. At worst Linear refuses it with invalid_grant,
    // which flags the login for a reconnect with the sign-in kept.
    if (!result.ok && isTransient(result) && login.stillBound(binding)) {
      result = await requestRefresh(credential.refreshToken);
    }
    if (!result.ok) {
      // A reconnect or disconnect that landed while the request was out
      // always wins: nothing is written for the old login.
      if (!login.stillBound(binding)) return { ok: false, errorCode: "connection_changed" };
      // Linear's OAuth error codes name no user or token.
      logger?.warn(
        "linear token refresh failed",
        { errorName: "LinearOAuthError", errorCode: result.errorCode },
        "connectors"
      );
      if (OAUTH_LOGIN_GONE.has(result.errorCode)) return login.markReconnect(binding);
      if (CLIENT_REFUSED.has(result.errorCode)) {
        return { ok: false, errorCode: "linear_unavailable" };
      }
      // Any other refusal (invalid_scope, invalid_request, …) won't change on
      // its own; signing in again is the one way forward.
      if (result.refused) return login.markReconnect(binding);
      return { ok: false, errorCode: "network" };
    }
    return login.saveRefreshed(binding, {
      ...credential,
      accessToken: result.tokens.accessToken,
      expiresAt: result.tokens.expiresAt,
      // Checked live: Linear may rotate the refresh token.
      // Whatever it returns is saved; otherwise the old one is kept.
      refreshToken: result.tokens.refreshToken ?? credential.refreshToken,
      scope: result.tokens.scopes ? result.tokens.scopes.join(",") : credential.scope,
      needsReconnect: false,
    });
  }

  const login = createBoundLogin({
    connectorId: "linear",
    credentials,
    sameLogin,
    isFresh: (credential) =>
      credential.expiresAt === null ||
      credential.expiresAt === undefined ||
      credential.expiresAt - EXPIRY_SKEW_MS > now(),
    refresh,
    logger,
  });

  // Best effort: the local login goes whatever Linear answers.
  async function revoke(credential) {
    await revokeTokens([
      { kind: "refresh", token: credential?.refreshToken },
      { kind: "access", token: credential?.accessToken },
    ]);
  }

  function statusOf(credential) {
    return {
      connected: true,
      accountLabel: credential.userName ?? null,
      workspaceLabel: credential.organizationName ?? null,
      needsReconnect: Boolean(credential.needsReconnect),
    };
  }

  return {
    authorize,
    getAccessToken: login.getAccessToken,
    boundCredential: login.boundCredential,
    markReconnect: login.markReconnect,
    revoke,
    statusOf,
    isConfigured,
  };
}

module.exports = {
  createLinearAuth,
  LINEAR_SCOPES,
  LINEAR_LOOPBACK,
  LINEAR_RELAY_REDIRECT_URI,
  linearRedirectUri,
  OAUTH_LOGIN_GONE,
  EXPIRY_SKEW_MS,
};
