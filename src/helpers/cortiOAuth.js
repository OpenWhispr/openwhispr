const crypto = require("crypto");
const { net, shell } = require("electron");
const debugLogger = require("./debugLogger");

const CORTI_PROTOCOL = "cortispeech";
const CORTI_REDIRECT_URI = `${CORTI_PROTOCOL}://auth/callback`;
const OAUTH_TIMEOUT_MS = 120_000;
const TOKEN_EXPIRY_BUFFER_MS = 30_000;

function _authUrl(region, tenant) {
  return `https://auth.${region}.corti.app/realms/${tenant}/protocol/openid-connect/auth`;
}

function _tokenUrl(region, tenant) {
  return `https://auth.${region}.corti.app/realms/${tenant}/protocol/openid-connect/token`;
}

function _decodeJwtPayload(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function _userFromClaims(claims) {
  if (!claims) return null;
  const name =
    claims.name ||
    [claims.given_name, claims.family_name].filter(Boolean).join(" ").trim() ||
    claims.preferred_username ||
    null;
  const email = claims.email || null;
  if (!name && !email) return null;
  return { name, email };
}

class CortiOAuth {
  constructor(environmentManager) {
    this.environmentManager = environmentManager;
    this._accessToken = null;
    this._accessTokenExpiresAt = 0;
    this._userInfo = null;
    this._pendingFlow = null;
  }

  _setAccessToken(token, expiresInSec) {
    this._accessToken = token;
    this._accessTokenExpiresAt = Date.now() + (expiresInSec || 300) * 1000;
    this._userInfo = _userFromClaims(_decodeJwtPayload(token));
  }

  startPkceFlow() {
    const env = this.environmentManager.getCortiEnvironment();
    const region = env.region;
    const tenant = this.environmentManager.getCortiTenant();
    const clientId = this.environmentManager.getCortiClientId();

    if (!region) {
      return Promise.reject(
        new Error(
          "Corti region is not set. Pick EU or US, or enter a region in Advanced."
        )
      );
    }

    if (!clientId) {
      const hint = env.clientIdEnvVar
        ? `Set ${env.clientIdEnvVar} in your .env file, or override it in Advanced.`
        : "Enter a Client ID in Advanced (Custom environments don't have a default).";
      return Promise.reject(new Error(`Corti client ID for ${env.label} is not configured. ${hint}`));
    }

    // Cancel any in-progress flow
    if (this._pendingFlow) {
      clearTimeout(this._pendingFlow.timeoutId);
      this._pendingFlow.reject(new Error("New login initiated"));
      this._pendingFlow = null;
    }

    return new Promise((resolve, reject) => {
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      const state = crypto.randomBytes(32).toString("hex");

      const timeoutId = setTimeout(() => {
        if (this._pendingFlow?.state === state) {
          this._pendingFlow = null;
        }
        reject(new Error("Corti login timed out (2 minutes). Please try again."));
      }, OAUTH_TIMEOUT_MS);

      this._pendingFlow = { codeVerifier, state, region, tenant, clientId, resolve, reject, timeoutId };

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: CORTI_REDIRECT_URI,
        response_type: "code",
        scope: "openid profile email",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      const authUrl = `${_authUrl(region, tenant)}?${params.toString()}`;
      debugLogger.debug("Corti PKCE: opening browser", { region, tenant, authUrl });
      shell
        .openExternal(authUrl)
        .then(() => {
          debugLogger.debug("Corti PKCE: browser opened");
        })
        .catch((err) => {
          clearTimeout(timeoutId);
          if (this._pendingFlow?.state === state) {
            this._pendingFlow = null;
          }
          reject(new Error(`Could not open browser: ${err?.message || err}`));
        });
    });
  }

  async handleCallback(url) {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    const state = parsed.searchParams.get("state");
    const error = parsed.searchParams.get("error");

    const flow = this._pendingFlow;
    if (!flow) {
      debugLogger.warn("Corti PKCE: received callback but no flow is pending");
      return;
    }

    if (state !== flow.state) {
      debugLogger.warn("Corti PKCE: state mismatch — possible CSRF");
      return;
    }

    clearTimeout(flow.timeoutId);
    this._pendingFlow = null;

    if (error) {
      flow.reject(new Error(`Corti OAuth error: ${error}`));
      return;
    }

    if (!code) {
      flow.reject(new Error("Corti OAuth: no code in callback"));
      return;
    }

    try {
      const tokenData = await this._exchangeCode(
        code,
        CORTI_REDIRECT_URI,
        flow.codeVerifier,
        flow.region,
        flow.tenant,
        flow.clientId
      );

      if (tokenData.error) {
        flow.reject(
          new Error(`Corti token exchange failed: ${tokenData.error_description || tokenData.error}`)
        );
        return;
      }

      this._setAccessToken(tokenData.access_token, tokenData.expires_in);

      if (tokenData.refresh_token) {
        await this.environmentManager.saveCortiRefreshToken(tokenData.refresh_token);
      }

      debugLogger.debug("Corti PKCE flow completed");
      flow.resolve({ success: true });
    } catch (err) {
      flow.reject(err);
    }
  }

  async getValidAccessToken() {
    if (this._accessToken && Date.now() < this._accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS) {
      return this._accessToken;
    }

    const refreshToken = this.environmentManager.getCortiRefreshToken();
    if (refreshToken) {
      return this._refresh(refreshToken);
    }

    throw new Error("Not connected to Corti — please connect via Settings.");
  }

  async disconnect() {
    this._accessToken = null;
    this._accessTokenExpiresAt = 0;
    this._userInfo = null;
    if (this._pendingFlow) {
      clearTimeout(this._pendingFlow.timeoutId);
      this._pendingFlow.reject(new Error("Disconnected"));
      this._pendingFlow = null;
    }
    await this.environmentManager.saveCortiRefreshToken("");
    debugLogger.debug("Corti PKCE disconnected");
  }

  async getAuthStatus() {
    const hasRefreshToken = Boolean(this.environmentManager.getCortiRefreshToken());
    const hasLiveToken =
      Boolean(this._accessToken) &&
      Date.now() < this._accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS;
    const isConnected = hasRefreshToken || hasLiveToken;

    // If we have a refresh token but no decoded user info yet (e.g. just
    // after app launch), refresh once so the JWT can be decoded. Failures
    // here are non-fatal — we just report connected without user info.
    if (isConnected && !this._userInfo && hasRefreshToken && !hasLiveToken) {
      try {
        await this.getValidAccessToken();
      } catch (err) {
        debugLogger.debug("Corti getAuthStatus: refresh failed", { error: err.message });
      }
    }

    return {
      isConnected,
      method: isConnected ? "pkce" : null,
      user: this._userInfo,
    };
  }

  async _refresh(refreshToken) {
    const env = this.environmentManager.getCortiEnvironment();
    const region = env.region;
    const tenant = this.environmentManager.getCortiTenant();
    const clientId = this.environmentManager.getCortiClientId();

    const data = await this._post(
      _tokenUrl(region, tenant),
      new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString()
    );

    if (data.error) {
      await this.environmentManager.saveCortiRefreshToken("");
      this._accessToken = null;
      this._userInfo = null;
      throw new Error(`Corti token refresh failed: ${data.error_description || data.error}`);
    }

    this._setAccessToken(data.access_token, data.expires_in);
    if (data.refresh_token) {
      await this.environmentManager.saveCortiRefreshToken(data.refresh_token);
    }
    debugLogger.debug("Corti token refreshed via PKCE");
    return this._accessToken;
  }

  async _exchangeCode(code, redirectUri, codeVerifier, region, tenant, clientId) {
    return this._post(
      _tokenUrl(region, tenant),
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: codeVerifier,
      }).toString()
    );
  }

  async _post(url, body) {
    const res = await net.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      useSessionCookies: false,
    });
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON from Corti auth: ${text.slice(0, 200)}`);
    }
  }
}

module.exports = CortiOAuth;
module.exports.CORTI_PROTOCOL = CORTI_PROTOCOL;
