const { createBoundLogin } = require("./boundLogin");
const {
  normalizeSalesforceOrigin,
  SALESFORCE_LOGIN_URL,
  USERINFO_PATH,
} = require("./salesforceApi");

const SALESFORCE_SCOPES = "api refresh_token openid";
const SALESFORCE_CALLBACK_URL = "http://localhost:1718/salesforce/callback";
const SALESFORCE_LOOPBACK = {
  redirectHost: "localhost",
  ports: [1718],
  callbackPath: "/salesforce/callback",
  timeoutMs: 300000,
};
const EXPIRY_SKEW_MS = 60000;

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

  function authorize({ signal } = {}) {
    const config = configuration();
    if (!config)
      return Promise.reject(Object.assign(new Error("not_configured"), { code: "not_configured" }));
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
          prompt: "consent",
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
    if (
      !credential.refreshToken ||
      credential.clientId !== config.clientId ||
      credential.loginUrl !== config.loginUrl
    )
      return login.markReconnect(binding);
    // Rotation can invalidate a refresh token even when its response is lost.
    // Never retry an uncertain refresh with that same token.
    const result = await api.refreshToken(
      { client_id: credential.clientId, refresh_token: credential.refreshToken },
      credential.loginUrl
    );
    if (!login.stillBound(binding)) return { ok: false, errorCode: "connection_changed" };
    if (!result.ok) {
      if (["invalid_client", "unauthorized_client"].includes(result.errorCode))
        return { ok: false, errorCode: "salesforce_unavailable" };
      if (result.errorCode === "invalid_grant" || result.refused || result.outcome === "unknown")
        return login.markReconnect(binding);
      return { ok: false, errorCode: "network" };
    }
    const tokens = parseTokens(result.data, now());
    if (
      !tokens ||
      tokens.instanceUrl !== credential.instanceUrl ||
      (tokens.scope !== null && !tokens.scope.split(/\s+/).includes("api"))
    )
      return login.markReconnect(binding);
    const identified = await identity(tokens.accessToken, credential.loginUrl);
    if (!login.stillBound(binding)) return { ok: false, errorCode: "connection_changed" };
    if (
      !identified.ok ||
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
      sameLogin(entry, binding) &&
      (typeof credentials.activeAccountId !== "function" ||
        credentials.activeAccountId() === binding.ownerAccountId),
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
    stillBound: login.stillBound,
  };
}

module.exports = {
  createSalesforceAuth,
  SALESFORCE_SCOPES,
  SALESFORCE_CALLBACK_URL,
  SALESFORCE_LOOPBACK,
};
