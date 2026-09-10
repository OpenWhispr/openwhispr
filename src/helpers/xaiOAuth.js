/**
 * SuperGrok OAuth for OpenWhispr (auth.x.ai → api.x.ai).
 *
 * Same shape as GoogleCalendarOAuth: PKCE via runOAuthLoopbackFlow, tokens
 * persisted by an injected store, Bearer refresh on the main-process proxy.
 * Not a console.x.ai API key and not a third-party gateway.
 */
const crypto = require("crypto");
const { runOAuthLoopbackFlow, OAuthFlowError } = require("./oauthLoopbackFlow");

const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_PLAN = "generic";
const XAI_OAUTH_REDIRECT_PORT = 56121;
const XAI_OAUTH_REDIRECT_PATH = "/callback";
const XAI_TOKEN_ENDPOINT = "https://auth.x.ai/oauth2/token";
const XAI_AUTHORIZE_ENDPOINT = "https://auth.x.ai/oauth2/authorize";
const XAI_API_BASE = "https://api.x.ai";
const REFRESH_SKEW_MS = 60 * 1000;

class ReauthRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "ReauthRequired";
  }
}

function s256Challenge(verifier) {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

function credentialsFromTokenResponse(payload, previous = null) {
  const expiresIn = Number.parseInt(payload?.expires_in, 10) || 3600;
  return {
    access_token: String(payload?.access_token || "").trim(),
    refresh_token: String(payload?.refresh_token || previous?.refresh_token || "").trim(),
    id_token: String(payload?.id_token || previous?.id_token || "").trim(),
    expires_at: Date.now() + expiresIn * 1000,
    token_type: String(payload?.token_type || "Bearer").trim() || "Bearer",
    scope: String(payload?.scope || previous?.scope || "").trim(),
  };
}

function credentialsStatus(creds) {
  if (!creds?.access_token && !creds?.refresh_token) {
    return { connected: false, expiresAt: null, scope: "" };
  }
  return {
    connected: true,
    expiresAt: creds.expires_at || null,
    scope: creds.scope || "",
  };
}

function isAccessFresh(creds, now = Date.now(), skewMs = REFRESH_SKEW_MS) {
  return Boolean(creds?.access_token) && Number(creds.expires_at) - skewMs > now;
}

class XaiOAuth {
  constructor({ store, postForm } = {}) {
    if (!store || typeof store.load !== "function" || typeof store.save !== "function") {
      throw new Error("XaiOAuth requires store.load and store.save");
    }
    this.store = store;
    this.postForm = postForm || ((url, body) => this._httpsPost(url, body));
    this._refreshChain = Promise.resolve();
  }

  startOAuthFlow() {
    const nonce = crypto.randomBytes(16).toString("hex");
    return runOAuthLoopbackFlow({
      errorParam: "xai_error",
      listenPort: XAI_OAUTH_REDIRECT_PORT,
      callbackPath: XAI_OAUTH_REDIRECT_PATH,
      pkceBytes: 64,
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          response_type: "code",
          client_id: XAI_OAUTH_CLIENT_ID,
          redirect_uri: redirectUri,
          scope: XAI_OAUTH_SCOPE,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          state,
          nonce,
          plan: XAI_OAUTH_PLAN,
        });
        return `${XAI_AUTHORIZE_ENDPOINT}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const tokenData = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);
        if (tokenData.error) {
          throw new OAuthFlowError(
            "token_exchange_failed",
            `Token exchange failed: ${tokenData.error_description || tokenData.error}`
          );
        }
        const creds = credentialsFromTokenResponse(tokenData);
        if (!creds.access_token) {
          throw new OAuthFlowError("token_exchange_failed", "xAI returned no access_token");
        }
        await this.store.save(creds);
        return credentialsStatus(creds);
      },
    });
  }

  async exchangeCodeForTokens(code, redirectUri, codeVerifier) {
    if (!codeVerifier) {
      throw new Error("PKCE code_verifier is required for token exchange.");
    }
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
      code_challenge: s256Challenge(codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    return this.postForm(XAI_TOKEN_ENDPOINT, body);
  }

  async refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString();
    return this.postForm(XAI_TOKEN_ENDPOINT, body);
  }

  async getValidAccessToken({ force = false } = {}) {
    const run = async () => {
      const creds = await this.store.load();
      if (!creds?.access_token && !creds?.refresh_token) {
        throw new ReauthRequired("no SuperGrok session — sign in with Grok");
      }
      if (!force && isAccessFresh(creds)) {
        return creds.access_token;
      }
      if (!creds.refresh_token) {
        throw new ReauthRequired("SuperGrok refresh token missing — sign in with Grok again");
      }
      const refreshed = await this.refreshAccessToken(creds.refresh_token);
      if (refreshed?.error || !refreshed?.access_token) {
        const statusHint = refreshed?.status;
        if (statusHint >= 400 && statusHint < 500) {
          throw new ReauthRequired("SuperGrok session expired — sign in with Grok again");
        }
        if (refreshed?.error) {
          throw new ReauthRequired(
            `SuperGrok refresh failed: ${refreshed.error_description || refreshed.error}`
          );
        }
        throw new Error("xAI token refresh returned no access_token");
      }
      const fresh = credentialsFromTokenResponse(refreshed, creds);
      await this.store.save(fresh);
      return fresh.access_token;
    };
    const pending = this._refreshChain.then(run, run);
    this._refreshChain = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  async status() {
    return credentialsStatus(await this.store.load());
  }

  async logout() {
    if (typeof this.store.clear === "function") {
      await this.store.clear();
    } else {
      await this.store.save(null);
    }
    return { connected: false, expiresAt: null, scope: "" };
  }

  async _httpsPost(urlString, body) {
    const { net } = require("electron");
    const response = await net.fetch(urlString, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(30000),
      useSessionCookies: false,
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: "invalid_json", error_description: text.slice(0, 200) };
    }
    if (!response.ok) {
      json.status = response.status;
      if (!json.error) json.error = `http_${response.status}`;
    }
    return json;
  }
}

module.exports = {
  XaiOAuth,
  ReauthRequired,
  s256Challenge,
  credentialsFromTokenResponse,
  credentialsStatus,
  isAccessFresh,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_PLAN,
  XAI_OAUTH_REDIRECT_PORT,
  XAI_OAUTH_REDIRECT_PATH,
  XAI_TOKEN_ENDPOINT,
  XAI_AUTHORIZE_ENDPOINT,
  XAI_API_BASE,
  REFRESH_SKEW_MS,
};
