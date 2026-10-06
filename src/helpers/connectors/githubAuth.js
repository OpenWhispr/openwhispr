// GitHub login and tokens (spec §5.1): the device flow for a GitHub App, and
// user-token refresh bound to one login. A device-flow token refreshes with
// the client id alone, so no client secret ships in the app or is ever sent.
const { createBoundLogin, CONNECTION_CHANGED } = require("./boundLogin");
const { describeError } = require("./errorSummary");
const { createDeviceFlow } = require("./githubDeviceFlow");
const { isTransportErrorCode } = require("./deliveryClassifier");

// User access tokens live 8 hours. Refreshing 5 minutes early keeps a comment
// from starting with a token that expires on the way.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// GitHub refused the OAuth client, not the user's login: a build shipped with
// a wrong or disabled client id. Signing in again won't help, and flagging
// every login for a reconnect would outlive the corrected build.
// incorrect_client_credentials and device_flow_disabled are GitHub's own;
// the other two are RFC 6749 §5.2's names for the same fault.
const CLIENT_REFUSED = new Set([
  "incorrect_client_credentials",
  "device_flow_disabled",
  "unauthorized_client",
  "invalid_client",
]);

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// GitHub omits the expiry fields when the App has token expiry turned off;
// that token never expires and has no refresh token.
function parseTokens(data, at) {
  if (!nonEmptyString(data?.access_token)) return null;
  return {
    accessToken: data.access_token,
    refreshToken: nonEmptyString(data.refresh_token) ? data.refresh_token : null,
    expiresAt: Number.isFinite(data.expires_in) ? at + data.expires_in * 1000 : null,
    refreshExpiresAt: Number.isFinite(data.refresh_token_expires_in)
      ? at + data.refresh_token_expires_in * 1000
      : null,
  };
}

// Only the GitHub login a pending action was approved under may act for it.
function sameLogin(entry, binding) {
  return Boolean(
    entry &&
    entry.credential &&
    binding &&
    entry.generation === binding.generation &&
    String(entry.credential.userId) === binding.accountId
  );
}

function createGithubAuth({
  api,
  credentials,
  getClientId,
  // (channel, payload) => void: shows the device code in the Settings row.
  broadcast = () => {},
  deviceFlow = createDeviceFlow({ api }),
  // Optional: logger.warn(message, { errorName, errorCode }, area). Never a
  // token, a device or user code, or a raw error.message.
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

  function reportProgress(started) {
    try {
      broadcast("connector-connect-progress", {
        connectorId: "github",
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresAt: started.expiresAt,
      });
    } catch (error) {
      // The code can't be shown, but the sign-in may still finish (a user who
      // already has the code), so it isn't abandoned here.
      logger?.warn("github connect progress failed", describeError(error), "connectors");
    }
  }

  // Who the new token belongs to. The user has already approved the code by
  // now, so a blip on this read (no answer, a 5xx) gets a second try rather
  // than throwing the approval away; a cancel ends it like one mid-poll.
  async function readUser(token, signal) {
    const throwIfCancelled = () => {
      if (signal?.aborted) throw codedError("oauth_cancelled");
    };
    let user = await api.rest("GET", "/user", { token, signal });
    throwIfCancelled();
    if (!user.ok && (user.outcome === "unknown" || isTransportErrorCode(user.errorCode))) {
      user = await api.rest("GET", "/user", { token, signal });
      throwIfCancelled();
    }
    return user;
  }

  // Returns the new login; the manager saves it under the account and slot
  // generation that started the connect, or nowhere (connection_changed).
  // `signal` ends the polling when a newer Connect replaces this one.
  async function authorize({ signal } = {}) {
    const id = clientId();
    if (!id) throw codedError("not_configured");
    const started = await deviceFlow.startDeviceAuthorization({ clientId: id, signal });
    reportProgress(started);
    const polled = await deviceFlow.pollForToken({
      clientId: id,
      deviceCode: started.deviceCode,
      intervalMs: started.intervalMs,
      expiresAt: started.expiresAt,
      signal,
    });
    const tokens = parseTokens(polled?.token, now());
    if (!tokens) throw codedError("token_exchange_failed");
    const user = await readUser(tokens.accessToken, signal);
    if (!user.ok || !Number.isInteger(user.data?.id) || !nonEmptyString(user.data?.login)) {
      throw codedError("token_exchange_failed");
    }
    return {
      ...tokens,
      userId: user.data.id,
      login: user.data.login,
      needsReconnect: false,
    };
  }

  async function requestRefresh(id, refreshToken) {
    const result = await api.accessToken({
      client_id: id,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (!result.ok) return result;
    const tokens = parseTokens(result.data, now());
    return tokens ? { ok: true, tokens } : { ok: false, errorCode: "bad_response" };
  }

  async function refresh(binding, credential) {
    if (!credential.refreshToken) return login.markReconnect(binding);
    if (Number.isFinite(credential.refreshExpiresAt) && credential.refreshExpiresAt <= now()) {
      return login.markReconnect(binding);
    }
    const id = clientId();
    // A login left by a build that had a client id: it can't be refreshed
    // here, but it isn't gone either.
    if (!id) return { ok: false, errorCode: "not_configured" };
    let result = await requestRefresh(id, credential.refreshToken);
    // A refused answer (GitHub said no, with a 2xx/4xx carrying its own
    // `error`) is definitive: retrying wastes a request and the refresh token
    // is single-use besides. A 429 asks us to wait, not to ask again at once.
    // Only a network error, a 5xx or an unreadable answer may pass, so only
    // those get a second try, and only while the login this refresh started
    // with still holds.
    if (!result.ok && !result.refused && !result.rateLimited && login.stillBound(binding)) {
      result = await requestRefresh(id, credential.refreshToken);
    }
    if (!result.ok) {
      // A reconnect or disconnect that landed while the request was out
      // always wins: nothing is written for the old login.
      if (!login.stillBound(binding)) return CONNECTION_CHANGED;
      // GitHub's OAuth error codes name no user or token.
      logger?.warn(
        "github token refresh failed",
        { errorName: "GithubOAuthError", errorCode: result.errorCode },
        "connectors"
      );
      if (result.rateLimited) return { ok: false, errorCode: "rate_limited" };
      if (CLIENT_REFUSED.has(result.errorCode)) return { ok: false, errorCode: "not_configured" };
      // Any other refused answer means the login can't be used as is, whether
      // it's one of the known dead-login codes or one never seen before:
      // reporting it as an indefinite "network" failure would leave every
      // action saying "Couldn't reach GitHub" forever while the row still
      // reads connected.
      if (result.refused) return login.markReconnect(binding);
      return { ok: false, errorCode: "network" };
    }
    // GitHub rotates the refresh token on every refresh and the old one stops
    // working, so the new one is always saved.
    return login.saveRefreshed(binding, {
      ...credential,
      accessToken: result.tokens.accessToken,
      expiresAt: result.tokens.expiresAt,
      refreshToken: result.tokens.refreshToken ?? credential.refreshToken,
      refreshExpiresAt: result.tokens.refreshExpiresAt ?? credential.refreshExpiresAt,
      needsReconnect: false,
    });
  }

  const login = createBoundLogin({
    connectorId: "github",
    credentials,
    sameLogin,
    isFresh: (credential) =>
      !Number.isFinite(credential.expiresAt) || credential.expiresAt - EXPIRY_SKEW_MS > now(),
    refresh,
    logger,
  });

  // The token after GitHub answered 401 to `rejectedToken`. Every refresh ends
  // the previous access token, so when another request has already replaced
  // it, that replacement is used: refreshing again would end the token the
  // other request is using and leave it with a 401 that reads as a dead login.
  function refreshRejected(binding, rejectedToken) {
    const credential = login.boundCredential(binding);
    const replaced = Boolean(credential) && credential.accessToken !== rejectedToken;
    return login.getAccessToken(binding, { forceRefresh: !replaced });
  }

  // Best effort: the local login goes whatever GitHub answers. This ends the
  // tokens themselves; the App's authorization stays on github.com, which is
  // why the Settings row still offers "Review on GitHub". GitHub refuses an
  // authenticated call here (403), so no token is sent as a bearer.
  async function revoke(credential) {
    const tokens = [credential?.refreshToken, credential?.accessToken].filter(nonEmptyString);
    if (tokens.length === 0) return;
    try {
      const result = await api.rest("POST", "/credentials/revoke", {
        body: { credentials: tokens },
      });
      if (!result.ok) {
        logger?.warn("github revoke failed", { errorCode: result.errorCode }, "connectors");
      }
    } catch (error) {
      logger?.warn("github revoke failed", describeError(error), "connectors");
    }
  }

  function statusOf(credential) {
    const refreshExpired =
      Number.isFinite(credential.refreshExpiresAt) && credential.refreshExpiresAt <= now();
    return {
      connected: true,
      accountLabel: nonEmptyString(credential.login) ? `@${credential.login}` : null,
      workspaceLabel: null,
      needsReconnect: Boolean(credential.needsReconnect) || refreshExpired,
    };
  }

  return {
    authorize,
    getAccessToken: login.getAccessToken,
    refreshRejected,
    markReconnect: login.markReconnect,
    revoke,
    statusOf,
    isConfigured,
  };
}

module.exports = { createGithubAuth, EXPIRY_SKEW_MS };
