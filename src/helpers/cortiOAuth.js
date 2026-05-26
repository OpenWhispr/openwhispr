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

class CortiOAuth {
  constructor(environmentManager) {
    this.environmentManager = environmentManager;
    this._accessToken = null;
    this._accessTokenExpiresAt = 0;
    this._pendingFlow = null;
  }

  startPkceFlow() {
    const region = this.environmentManager.getCortiRegion();
    const tenant = this.environmentManager.getCortiTenant();
    const clientId = this.environmentManager.getCortiClientId();

    if (!clientId) return Promise.reject(new Error("Corti Client ID is required to connect"));

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
        scope: "openid",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

      shell.openExternal(`${_authUrl(region, tenant)}?${params.toString()}`);
      debugLogger.debug("Corti PKCE: opened browser", { region, tenant });
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

      this._accessToken = tokenData.access_token;
      this._accessTokenExpiresAt = Date.now() + (tokenData.expires_in || 300) * 1000;

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
    if (this._pendingFlow) {
      clearTimeout(this._pendingFlow.timeoutId);
      this._pendingFlow.reject(new Error("Disconnected"));
      this._pendingFlow = null;
    }
    await this.environmentManager.saveCortiRefreshToken("");
    debugLogger.debug("Corti PKCE disconnected");
  }

  getAuthStatus() {
    const hasRefreshToken = Boolean(this.environmentManager.getCortiRefreshToken());
    const hasLiveToken =
      Boolean(this._accessToken) &&
      Date.now() < this._accessTokenExpiresAt - TOKEN_EXPIRY_BUFFER_MS;
    return {
      isConnected: hasRefreshToken || hasLiveToken,
      method: hasRefreshToken || hasLiveToken ? "pkce" : null,
    };
  }

  async _refresh(refreshToken) {
    const region = this.environmentManager.getCortiRegion();
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
      throw new Error(`Corti token refresh failed: ${data.error_description || data.error}`);
    }

    this._accessToken = data.access_token;
    this._accessTokenExpiresAt = Date.now() + (data.expires_in || 300) * 1000;
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
