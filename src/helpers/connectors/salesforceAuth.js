const { createBoundLogin } = require("./boundLogin");
const {
  normalizeSalesforceOrigin,
  SALESFORCE_LOGIN_URL,
  USERINFO_PATH,
} = require("./salesforceApi");

const SALESFORCE_SCOPES = "api refresh_token openid";
// Salesforce allows a plain-http callback only on localhost, so the
// loopback server answers on both 127.0.0.1 and ::1 (oauthLoopbackFlow).
const SALESFORCE_LOOPBACK = {
  redirectHost: "localhost",
  ports: [1718],
  callbackPath: "/salesforce/callback",
  timeoutMs: 300000,
};
const EXPIRY_SKEW_MS = 60000;
// Salesforce refused the OAuth client, not the user's login: a build fault
// that signing in again won't fix.
const CLIENT_REFUSED = new Set(["invalid_client", "invalid_client_id", "unauthorized_client"]);
// Answers that mean "ask again later", even when they come with a 4xx.
const TRANSIENT_STATUS = new Set([408, 429]);
const TRANSIENT_OAUTH_ERRORS = new Set([
  "temporarily_unavailable",
  "server_error",
  "rate_limit_exceeded",
]);

// A redirect means the host moved (a renamed My Domain, say): asking it
// again won't help, so it counts as a refusal too.
function isRefusal(result) {
  if (result.errorCode === "redirect_refused") return true;
  return (
    result.refused === true &&
    !TRANSIENT_STATUS.has(result.status) &&
    !TRANSIENT_OAUTH_ERRORS.has(result.errorCode)
  );
}

function transientError(result) {
  return {
    ok: false,
    errorCode:
      result.status === 429 || result.errorCode === "rate_limit_exceeded"
        ? "rate_limited"
        : "network",
  };
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

// What a user types for a sandbox or My Domain: a bare host, a URL, or with a
// trailing slash. Only Salesforce's sign-in hosts and My Domains are accepted.
function loginOrigin(loginDomain) {
  const host = loginDomain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return normalizeSalesforceOrigin(`https://${host}`, { login: true });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function validIdentity(data) {
  return (
    /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(data?.user_id ?? "") &&
    /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(data?.organization_id ?? "")
  );
}

function parseTokens(data, now) {
  const instanceUrl = normalizeSalesforceOrigin(data?.instance_url);
  if (!nonEmptyString(data?.access_token) || !instanceUrl) return null;
  return {
    accessToken: data.access_token,
    refreshToken: nonEmptyString(data.refresh_token) ? data.refresh_token : null,
    instanceUrl,
    // Salesforce session policies often omit expires_in; INVALID_SESSION_ID
    // then triggers a bound refresh instead of guessing the session lifetime.
    expiresAt:
      Number.isFinite(data.expires_in) && data.expires_in > 0 ? now + data.expires_in * 1000 : null,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
}

function sameLogin(entry, binding) {
  return Boolean(
    entry &&
    binding &&
    entry.generation === binding.generation &&
    entry.credential.userId === binding.accountId &&
    entry.credential.organizationId === binding.workspaceId &&
    entry.credential.instanceUrl === binding.instanceUrl
  );
}

function createSalesforceAuth({
  api,
  credentials,
  getClientId,
  getLoginUrl = () => SALESFORCE_LOGIN_URL,
  runOAuthLoopbackFlow,
  OAuthFlowError,
  renderResultPage = null,
  logger = null,
  now = Date.now,
}) {
  function configuration() {
    const clientId = getClientId();
    const loginUrl = normalizeSalesforceOrigin(getLoginUrl(), { login: true });
    return nonEmptyString(clientId) && loginUrl ? { clientId, loginUrl } : null;
  }

  function isConfigured() {
    return configuration() !== null;
  }

  async function revoke(credential) {
    const token = credential?.refreshToken || credential?.accessToken;
    if (!nonEmptyString(token)) return;
    try {
      const result = await api.revokeToken(token, credential.loginUrl);
      if (!result.ok) logger?.warn("salesforce revoke failed", {}, "connectors");
    } catch {
      logger?.warn("salesforce revoke failed", {}, "connectors");
    }
  }

  function identity(accessToken, loginUrl) {
    return api.request({ instanceUrl: loginUrl, accessToken, method: "GET", path: USERINFO_PATH });
  }

  // A typed sandbox or My Domain wins; a Reconnect keeps the host the login
  // was made on; anything else signs in at the build's default.
  function loginUrlFor(loginDomain, config) {
    if (loginDomain) return loginOrigin(loginDomain);
    const accountId = credentials.activeAccountId();
    const saved = accountId ? credentials.read(accountId, "salesforce")?.credential : null;
    return saved && normalizeSalesforceOrigin(saved.loginUrl, { login: true }) === saved.loginUrl
      ? saved.loginUrl
      : config.loginUrl;
  }

  function authorize({ signal, loginDomain } = {}) {
    const configured = configuration();
    if (!configured) return Promise.reject(codedError("not_configured"));
    const loginUrl = loginUrlFor(loginDomain, configured);
    if (!loginUrl) return Promise.reject(codedError("invalid_login_domain"));
    const config = { ...configured, loginUrl };
    return runOAuthLoopbackFlow({
      ...SALESFORCE_LOOPBACK,
      errorParam: "salesforce_error",
      renderResultPage,
      signal,
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SALESFORCE_SCOPES,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          // "login" lets the user pick another Salesforce user than the one
          // signed in in the browser.
          prompt: "login consent",
        });
        return `${config.loginUrl}/services/oauth2/authorize?${params}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const result = await api.exchangeToken(
          {
            client_id: config.clientId,
            grant_type: "authorization_code",
            code,
            redirect_uri: redirectUri,
            code_verifier: codeVerifier,
          },
          config.loginUrl
        );
        if (!result.ok)
          throw new OAuthFlowError("token_exchange_failed", "salesforce_token_exchange_failed");
        const tokens = parseTokens(result.data, now());
        const refuse = async (errorCode) => {
          await revoke({
            accessToken: result.data?.access_token,
            refreshToken: result.data?.refresh_token,
            loginUrl: config.loginUrl,
          });
          throw new OAuthFlowError(errorCode, `salesforce_${errorCode}`);
        };
        if (!tokens || !tokens.refreshToken) return refuse("token_exchange_failed");
        if (!tokens.scope?.split(/\s+/).includes("api")) return refuse("permission_not_granted");
        const identified = await identity(tokens.accessToken, config.loginUrl);
        if (!identified.ok || !validIdentity(identified.data))
          return refuse("token_exchange_failed");
        return {
          ...tokens,
          clientId: config.clientId,
          loginUrl: config.loginUrl,
          userId: identified.data.user_id,
          organizationId: identified.data.organization_id,
          userName:
            identified.data.preferred_username || identified.data.name || identified.data.user_id,
          // UserInfo supplies the organization id, but not its name. The
          // verified My Domain distinguishes organizations without extra access.
          organizationName: new URL(tokens.instanceUrl).hostname,
          needsReconnect: false,
        };
      },
    });
  }

  async function refresh(binding, credential) {
    const config = configuration();
    if (!config) return { ok: false, errorCode: "salesforce_unavailable" };
    // Each login refreshes at the host it was made on (production, a sandbox or a My Domain).
    if (
      !credential.refreshToken ||
      credential.clientId !== config.clientId ||
      normalizeSalesforceOrigin(credential.loginUrl, { login: true }) !== credential.loginUrl
    )
      return login.markReconnect(binding);
    // Not retried here. A timeout, a 5xx, a 408 or a 429 keeps the login for
    // the next action: if Salesforce rotated the refresh token and the answer
    // was lost, that next refresh gets invalid_grant and flags the login then.
    const result = await api.refreshToken(
      { client_id: credential.clientId, refresh_token: credential.refreshToken },
      credential.loginUrl
    );
    if (!login.stillBound(binding)) return { ok: false, errorCode: "connection_changed" };
    if (!result.ok) {
      if (CLIENT_REFUSED.has(result.errorCode))
        return { ok: false, errorCode: "salesforce_unavailable" };
      // invalid_grant, inactive_user, invalid_request…: none changes on its own.
      return isRefusal(result) ? login.markReconnect(binding) : transientError(result);
    }
    const tokens = parseTokens(result.data, now());
    if (
      !tokens ||
      tokens.instanceUrl !== credential.instanceUrl ||
      (tokens.scope !== null && !tokens.scope.split(/\s+/).includes("api"))
    )
      return login.markReconnect(binding);
    // A rotated refresh token is the only way back in, so it's saved before
    // the identity check, which can fail on its own. The new access token
    // waits for that check.
    if (tokens.refreshToken && tokens.refreshToken !== credential.refreshToken) {
      const rotated = login.saveRefreshed(binding, {
        ...credential,
        refreshToken: tokens.refreshToken,
      });
      if (!rotated.ok) return rotated;
    }
    const identified = await identity(tokens.accessToken, credential.loginUrl);
    if (!login.stillBound(binding)) return { ok: false, errorCode: "connection_changed" };
    if (!identified.ok)
      return isRefusal(identified) ? login.markReconnect(binding) : transientError(identified);
    if (
      !validIdentity(identified.data) ||
      identified.data.user_id !== credential.userId ||
      identified.data.organization_id !== credential.organizationId
    )
      return login.markReconnect(binding);
    return login.saveRefreshed(binding, {
      ...credential,
      ...tokens,
      refreshToken: tokens.refreshToken ?? credential.refreshToken,
      scope: tokens.scope ?? credential.scope,
      needsReconnect: false,
    });
  }

  const login = createBoundLogin({
    connectorId: "salesforce",
    credentials,
    sameLogin: (entry, binding) =>
      sameLogin(entry, binding) && credentials.activeAccountId() === binding.ownerAccountId,
    isFresh: (credential) =>
      nonEmptyString(credential.accessToken) &&
      (credential.expiresAt == null || credential.expiresAt - EXPIRY_SKEW_MS > now()),
    refresh,
    logger,
  });

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
    isConfigured,
    statusOf,
    revoke,
    getAccessToken: login.getAccessToken,
    boundCredential: login.boundCredential,
    markReconnect: login.markReconnect,
  };
}

module.exports = { createSalesforceAuth };
