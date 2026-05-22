const http = require("http");
const crypto = require("crypto");
const { net, shell } = require("electron");
const debugLogger = require("./debugLogger");

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
  }

  startPkceFlow() {
    const region = this.environmentManager.getCortiRegion();
    const tenant = this.environmentManager.getCortiTenant();
    const clientId = this.environmentManager.getCortiClientId();

    if (!clientId) return Promise.reject(new Error("Corti Client ID is required to connect"));

    return new Promise((resolve, reject) => {
      const codeVerifier = crypto.randomBytes(32).toString("base64url");
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      const state = crypto.randomBytes(32).toString("hex");

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        const returnedState = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body style="font-family:sans-serif;padding:2em"><h3>Login failed: ${error}</h3><p>You can close this tab.</p></body></html>`
          );
          cleanup();
          reject(new Error(`Corti OAuth error: ${error}`));
          return;
        }

        if (!code || returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h3>Invalid request.</h3></body></html>");
          return;
        }

        try {
          const redirectUri = `http://127.0.0.1:${server.address().port}`;
          const tokenData = await this._exchangeCode(
            code,
            redirectUri,
            codeVerifier,
            region,
            tenant,
            clientId
          );

          if (tokenData.error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              `<html><body style="font-family:sans-serif;padding:2em"><h3>Token exchange failed.</h3><p>You can close this tab.</p></body></html>`
            );
            cleanup();
            reject(new Error(`Corti token exchange failed: ${tokenData.error_description || tokenData.error}`));
            return;
          }

          this._accessToken = tokenData.access_token;
          this._accessTokenExpiresAt = Date.now() + (tokenData.expires_in || 300) * 1000;

          if (tokenData.refresh_token) {
            await this.environmentManager.saveCortiRefreshToken(tokenData.refresh_token);
          }

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body style="font-family:sans-serif;padding:2em"><h3>Connected to Corti!</h3><p>You can close this tab and return to OpenWhispr.</p></body></html>`
          );
          cleanup();
          debugLogger.debug("Corti PKCE flow completed");
          resolve({ success: true });
        } catch (err) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            `<html><body style="font-family:sans-serif;padding:2em"><h3>Login failed.</h3><p>You can close this tab.</p></body></html>`
          );
          cleanup();
          reject(err);
        }
      });

      let timeoutId;
      const cleanup = () => {
        clearTimeout(timeoutId);
        server.close();
      };

      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: `http://127.0.0.1:${port}`,
          response_type: "code",
          scope: "openid",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        shell.openExternal(`${_authUrl(region, tenant)}?${params.toString()}`);
        debugLogger.debug("Corti PKCE: opened browser", { region, tenant, port });
      });

      timeoutId = setTimeout(() => {
        server.close();
        reject(new Error("Corti login timed out (2 minutes). Please try again."));
      }, OAUTH_TIMEOUT_MS);

      server.on("error", (err) => {
        cleanup();
        reject(err);
      });
    });
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
      // Refresh token is invalid — wipe it so the user is prompted to reconnect
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
