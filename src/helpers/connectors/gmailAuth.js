// Gmail login and tokens (spec §5.1). The OAuth flow is ported from #1819's
// gmailOAuth.js (Gabriel Stein). Plan 3 adds the granted-scope and verified-
// email checks, the refresh bound to one login, and revoking the grant.
const { createBoundLogin } = require("./boundLogin");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
// gmail.send is Google's only sensitive (not restricted) Gmail scope. Any
// read, compose or modify scope would need a CASA assessment (spec §3).
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GMAIL_SCOPES = `openid email ${GMAIL_SEND_SCOPE}`;
// Google desktop clients accept http://127.0.0.1 on any port with no path,
// so there is no relay. A first sign-in (account choice, 2FA, the
// unverified-app screen) can outlast the calendars' 120 s.
const GMAIL_LOOPBACK = { ports: [0], callbackPath: "", timeoutMs: 5 * 60 * 1000 };
// Access tokens live an hour. Refreshing 5 minutes early keeps a send from
// starting with a token that expires on the way.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
// The one token-endpoint error that means the login itself is gone: access
// revoked at myaccount.google.com, a password change, or a Testing-status
// project's 7-day expiry. Every other error keeps the login.
const OAUTH_LOGIN_GONE = new Set(["invalid_grant"]);
// Google refused the OAuth client itself (or it was deleted), or the build
// has none: a configuration fault, not the user's login, and neither asking
// again nor signing in again helps.
const CLIENT_REFUSED = new Set([
  "invalid_client",
  "unauthorized_client",
  "deleted_client",
  "not_configured",
]);
// The one refusal Google documents as worth asking again.
const TRANSIENT_OAUTH_ERRORS = new Set(["temporarily_unavailable"]);
// A Workspace admin blocked the app, or it is restricted to another org.
// At sign-in Google usually shows its own "Access blocked" page and never
// redirects back, so these arrive mainly from a refresh after the admin's
// change; a redirect that does carry one is still distinct from an ordinary
// decline (e.g. "access_denied"), which stays oauth_denied.
const DOMAIN_POLICY_ERRORS = new Set(["admin_policy_enforced", "org_internal"]);

// A complete GMAIL_* pair overrides the calendar's client, which lives in
// the same Google Cloud project, so CI and release configs need no new
// secrets. The fallback is pair-wise: an id from one client with another's
// secret is a pair Google refuses (invalid_client), so half a pair is ignored.
function gmailClientCredentials(env) {
  for (const [idKey, secretKey] of [
    ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET"],
    ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET"],
  ]) {
    const clientId = env?.[idKey];
    const clientSecret = env?.[secretKey];
    if (clientId && clientSecret) return { clientId, clientSecret };
  }
  return { clientId: null, clientSecret: null };
}

// A Google client id starts with its Cloud project's number
// ("123456789012-abc.apps.googleusercontent.com").
function googleProjectOf(clientId) {
  if (!nonEmptyString(clientId)) return null;
  return /^(\d+)-/.exec(clientId)?.[1] ?? clientId;
}

/**
 * Whether revoking this Gmail login would also end a connected Google
 * Calendar login. Google's /revoke withdraws the user's whole grant to a
 * Cloud project, and Gmail falls back to the calendar's client. `email` is
 * the Gmail login's address; unknown (a grant refused before its identity
 * was read) counts as any connected calendar account.
 */
function sharesCalendarGrant({ gmailClientId, calendarClientId, getCalendarEmails, email }) {
  const project = googleProjectOf(gmailClientId);
  if (!project || project !== googleProjectOf(calendarClientId)) return false;
  const wanted = nonEmptyString(email) ? email.toLowerCase() : null;
  // Read only now: a separate project never needs the calendar database,
  // whose failure would otherwise count as "shared" and skip the revoke.
  return (getCalendarEmails() ?? []).some(
    (address) => nonEmptyString(address) && (!wanted || address.toLowerCase() === wanted)
  );
}

function codedError(code) {
  return Object.assign(new Error(code), { code });
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// Without expires_in the token counts as already stale, so its first use
// refreshes it instead of trusting it forever.
function parseTokens(data, at) {
  if (!nonEmptyString(data?.access_token)) return null;
  return {
    accessToken: data.access_token,
    refreshToken: nonEmptyString(data.refresh_token) ? data.refresh_token : null,
    expiresAt: Number.isFinite(data.expires_in) ? at + data.expires_in * 1000 : at,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
}

// Google returns granted scopes as full URLs, space separated, in any order,
// so only an exact match counts.
function grantsSend(scope) {
  return typeof scope === "string" && scope.split(/\s+/).includes(GMAIL_SEND_SCOPE);
}

// The id_token comes straight from Google's token endpoint over TLS, which
// is what lets its claims be read without checking the signature (OIDC Core
// §3.1.3.7). An id_token from anywhere else must never be read this way.
function idTokenClaims(idToken) {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")
    );
    return claims && typeof claims === "object" ? claims : null;
  } catch {
    return null;
  }
}

// Only the Google login a pending action was approved under may act for it.
function sameLogin(entry, binding) {
  return Boolean(
    entry &&
    binding &&
    entry.generation === binding.generation &&
    entry.credential.sub === binding.accountId
  );
}

function createGmailAuth({
  api,
  credentials,
  getClientCredentials,
  runOAuthLoopbackFlow,
  OAuthFlowError,
  renderResultPage = null,
  // (email, clientId) => true when revoking that Google login, issued to
  // that OAuth client, would also end a connected calendar's grant
  // (sharesCalendarGrant). Gmail then drops only its own tokens, the way
  // disconnecting the calendar never revokes.
  sharesGrant = () => false,
  // Optional: told about failures worth a log line via
  // logger.warn(message, { errorName, errorCode }, area). Never a token, an
  // address or a raw error.message.
  logger = null,
  now = Date.now,
}) {
  function oauthClient() {
    const { clientId, clientSecret } = getClientCredentials() ?? {};
    return nonEmptyString(clientId) && nonEmptyString(clientSecret)
      ? { clientId, clientSecret }
      : null;
  }

  function isConfigured() {
    return oauthClient() !== null;
  }

  // A check that can't run (the calendar database unreadable) keeps the
  // calendar safe: the grant is treated as shared.
  function grantIsShared(email, clientId) {
    try {
      return sharesGrant(email, clientId) === true;
    } catch {
      return true;
    }
  }

  // Another OpenWhispr account on this device signed in to Gmail as the same
  // Google user through the same Cloud project holds the same grant, so a
  // revoke would sign it out too. The login being revoked may still be
  // stored (Disconnect clears it afterwards); its token tells it apart. An
  // unknown email counts as any Gmail login, and an unreadable store as
  // shared, like the calendar check.
  function grantHeldByAnotherLogin(token, email, clientId) {
    const project = googleProjectOf(clientId);
    const wanted = nonEmptyString(email) ? email.toLowerCase() : null;
    try {
      return credentials
        .readAllAccounts("gmail")
        .some(
          (other) =>
            other.refreshToken !== token &&
            other.accessToken !== token &&
            (!wanted || other.email?.toLowerCase() === wanted) &&
            googleProjectOf(other.clientId ?? oauthClient()?.clientId) === project
        );
    } catch {
      return true;
    }
  }

  // Best effort: the local login goes whatever Google answers. Erasing the
  // device revokes even a shared grant, since every login goes with it.
  // `clientId` is the client the login was issued to (a login saved before
  // it was recorded counts as the current one). Returns { kept: true } when
  // a grant shared with a connected calendar was left in place.
  async function revokeToken(token, email, { erasingDevice = false, clientId = null } = {}) {
    if (!nonEmptyString(token)) return null;
    const issuedTo = clientId ?? oauthClient()?.clientId ?? null;
    if (!erasingDevice && grantIsShared(email, issuedTo)) {
      logger?.info?.(
        "gmail revoke skipped: grant shared with a connected calendar",
        {},
        "connectors"
      );
      return { kept: true };
    }
    if (!erasingDevice && grantHeldByAnotherLogin(token, email, issuedTo)) {
      logger?.info?.(
        "gmail revoke skipped: grant shared with another account's Gmail login",
        {},
        "connectors"
      );
      return null;
    }
    const revoked = await api.revokeToken(token);
    if (!revoked.ok) logger?.warn("gmail revoke failed", {}, "connectors");
    return null;
  }

  // `signal` gives the sign-in up when a newer Connect replaces it.
  function authorize({ signal } = {}) {
    const client = oauthClient();
    // Fail before opening a browser on a client_id-less URL.
    if (!client) return Promise.reject(codedError("not_configured"));
    return runOAuthLoopbackFlow({
      errorParam: "gmail_error",
      ...GMAIL_LOOPBACK,
      renderResultPage,
      signal,
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: client.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GMAIL_SCOPES,
          access_type: "offline",
          prompt: "consent",
          // Only gmail.send, never scopes granted to this client before.
          include_granted_scopes: "false",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        return `${GOOGLE_AUTH_URL}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const exchanged = await api.exchangeToken({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        });
        if (!exchanged.ok) {
          throw new OAuthFlowError("token_exchange_failed", "gmail_token_exchange_failed");
        }
        const data = exchanged.data ?? {};
        const claims = nonEmptyString(data.id_token) ? idTokenClaims(data.id_token) : null;
        // A grant Google issued that can't become a login is revoked at once,
        // not left live at Google with nothing using it.
        const refuse = async (redirectCode) => {
          await revokeToken(
            nonEmptyString(data.refresh_token) ? data.refresh_token : data.access_token,
            claims?.email
          );
          return new OAuthFlowError(redirectCode, `gmail_${redirectCode}`);
        };
        const tokens = parseTokens(data, now());
        if (!tokens || !tokens.refreshToken || !nonEmptyString(data.id_token)) {
          throw await refuse("token_exchange_failed");
        }
        // Granular consent lets the user untick "Send email on your behalf".
        if (!grantsSend(tokens.scope)) throw await refuse("permission_not_granted");
        if (
          claims?.email_verified !== true ||
          !nonEmptyString(claims.email) ||
          !nonEmptyString(claims.sub)
        ) {
          throw await refuse("email_not_verified");
        }
        return {
          email: claims.email,
          sub: claims.sub,
          clientId: client.clientId,
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
          scope: tokens.scope,
          needsReconnect: false,
        };
      },
    }).catch((error) => {
      // The loopback flow maps every provider `error` redirect to
      // oauth_denied, keeping the raw value as providerError. A Workspace
      // admin block or an org-restricted app gets its own code so Settings
      // can say so instead of the generic "access wasn't allowed".
      if (error?.code === "oauth_denied" && DOMAIN_POLICY_ERRORS.has(error.providerError)) {
        throw codedError("domain_policy");
      }
      throw error;
    });
  }

  async function requestRefresh(refreshToken) {
    const client = oauthClient();
    if (!client) return { ok: false, errorCode: "not_configured" };
    const result = await api.exchangeToken({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
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

  // A refresh token only works with the client it was issued to. A build
  // that moved Gmail to another client (a GMAIL_* pair added or changed)
  // needs a new sign-in, not an "unavailable" that never clears.
  function issuedToAnotherClient(credential) {
    const current = oauthClient()?.clientId;
    return (
      nonEmptyString(credential.clientId) && Boolean(current) && credential.clientId !== current
    );
  }

  async function refresh(binding, credential) {
    if (!credential.refreshToken || issuedToAnotherClient(credential)) {
      return login.markReconnect(binding);
    }
    let result = await requestRefresh(credential.refreshToken);
    // Network errors, 5xx, temporarily_unavailable and unreadable answers
    // may pass. Google refresh tokens aren't single-use, so asking again is
    // safe, but only while the login this refresh started with still holds.
    if (
      !result.ok &&
      !result.refused &&
      !CLIENT_REFUSED.has(result.errorCode) &&
      login.stillBound(binding)
    ) {
      result = await requestRefresh(credential.refreshToken);
    }
    if (!result.ok) {
      // A reconnect or disconnect that landed while the request was out
      // always wins: nothing is written for the old login.
      if (!login.stillBound(binding)) return { ok: false, errorCode: "connection_changed" };
      // Google's OAuth error codes name no user or token.
      logger?.warn(
        "gmail token refresh failed",
        { errorName: "GoogleOAuthError", errorCode: result.errorCode },
        "connectors"
      );
      if (OAUTH_LOGIN_GONE.has(result.errorCode)) return login.markReconnect(binding);
      if (CLIENT_REFUSED.has(result.errorCode)) {
        return { ok: false, errorCode: "gmail_unavailable" };
      }
      // A Workspace admin restricted the app after it was connected.
      if (DOMAIN_POLICY_ERRORS.has(result.errorCode)) {
        return { ok: false, errorCode: "domain_policy" };
      }
      // Any other refusal (invalid_scope, …) won't change on its own; signing
      // in again is the one way forward.
      if (result.refused) return login.markReconnect(binding);
      return { ok: false, errorCode: "network" };
    }
    return login.saveRefreshed(binding, {
      ...credential,
      accessToken: result.tokens.accessToken,
      expiresAt: result.tokens.expiresAt,
      // Google keeps the refresh token unless it sends a new one.
      refreshToken: result.tokens.refreshToken ?? credential.refreshToken,
      scope: result.tokens.scope ?? credential.scope,
      needsReconnect: false,
    });
  }

  const login = createBoundLogin({
    connectorId: "gmail",
    credentials,
    sameLogin,
    isFresh: (credential) => credential.expiresAt - EXPIRY_SKEW_MS > now(),
    refresh,
    logger,
  });

  // Revoking the refresh token ends the whole grant, access tokens included.
  // An expired access token can't be revoked (400 invalid_token), so it is
  // only the fallback.
  async function revoke(credential, options) {
    return revokeToken(
      nonEmptyString(credential?.refreshToken) ? credential.refreshToken : credential?.accessToken,
      credential?.email,
      { ...options, clientId: credential?.clientId ?? null }
    );
  }

  function statusOf(credential) {
    return {
      connected: true,
      accountLabel: credential.email ?? null,
      workspaceLabel: null,
      needsReconnect: Boolean(credential.needsReconnect),
    };
  }

  return {
    authorize,
    boundCredential: login.boundCredential,
    getAccessToken: login.getAccessToken,
    markReconnect: login.markReconnect,
    revoke,
    statusOf,
    isConfigured,
  };
}

module.exports = {
  createGmailAuth,
  gmailClientCredentials,
  sharesCalendarGrant,
  EXPIRY_SKEW_MS,
};
