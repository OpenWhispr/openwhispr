const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { shell } = require("electron");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE = "openid email https://www.googleapis.com/auth/calendar.readonly";
const OAUTH_TIMEOUT_MS = 120000;
const DEFAULT_DESKTOP_CALLBACK_URL = "https://openwhispr.com/auth/desktop-callback";

const PROTOCOL_BY_CHANNEL = {
  development: "openwhispr-dev",
  staging: "openwhispr-staging",
  production: "openwhispr",
};

class GoogleCalendarOAuth {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
  }

  getClientId() {
    return process.env.GOOGLE_CALENDAR_CLIENT_ID;
  }

  getClientSecret() {
    return process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  }

  _getDesktopCallbackUrl() {
    return process.env.VITE_OPENWHISPR_OAUTH_CALLBACK_URL || DEFAULT_DESKTOP_CALLBACK_URL;
  }

  _getProtocol() {
    const channel = process.env.OPENWHISPR_CHANNEL || "production";
    return PROTOCOL_BY_CHANNEL[channel] || PROTOCOL_BY_CHANNEL.production;
  }

  _buildCallbackRedirect(params) {
    const url = new URL(this._getDesktopCallbackUrl());
    url.searchParams.set("protocol", this._getProtocol());
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  _redirect(res, params) {
    res.writeHead(302, { Location: this._buildCallbackRedirect(params) });
    res.end();
  }

  startOAuthFlow() {
    return new Promise((resolve, reject) => {
      const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
      const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
      const state = crypto.randomBytes(32).toString("hex");

      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, `http://127.0.0.1`);
          const returnedState = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            this._redirect(res, { gcal_error: error });
            cleanup();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (!code || returnedState !== state) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end("<html><body><h3>Invalid request.</h3></body></html>");
            return;
          }

          const redirectUri = `http://127.0.0.1:${server.address().port}`;
          const tokenData = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);

          if (tokenData.error) {
            this._redirect(res, { gcal_error: "token_exchange_failed" });
            cleanup();
            reject(
              new Error(`Token exchange failed: ${tokenData.error_description || tokenData.error}`)
            );
            return;
          }

          let email = null;
          if (tokenData.id_token) {
            try {
              const payload = JSON.parse(
                Buffer.from(tokenData.id_token.split(".")[1], "base64url").toString()
              );
              email = payload.email;
            } catch {}
          }

          if (!email) {
            this._redirect(res, { gcal_error: "no_email" });
            cleanup();
            reject(new Error("Could not extract email from Google OAuth response"));
            return;
          }

          const expiresAt = Date.now() + tokenData.expires_in * 1000;
          this.databaseManager.saveGoogleTokens({
            google_email: email,
            access_token: tokenData.access_token,
            refresh_token: tokenData.refresh_token,
            expires_at: expiresAt,
            scope: tokenData.scope || CALENDAR_SCOPE,
          });

          this._redirect(res, { gcal_connected: "true" });
          cleanup();
          resolve({ success: true, email });
        } catch (err) {
          this._redirect(res, { gcal_error: "server_error" });
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
        const redirectUri = `http://127.0.0.1:${port}`;

        const params = new URLSearchParams({
          client_id: this.getClientId(),
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CALENDAR_SCOPE,
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        shell.openExternal(`${GOOGLE_AUTH_URL}?${params.toString()}`);
      });

      timeoutId = setTimeout(() => {
        server.close();
        reject(new Error("OAuth flow timed out"));
      }, OAUTH_TIMEOUT_MS);

      server.on("error", (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  async exchangeCodeForTokens(code, redirectUri, codeVerifier) {
    const body = new URLSearchParams({
      code,
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString();

    return this._httpsPost(GOOGLE_TOKEN_URL, body);
  }

  async refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
      client_id: this.getClientId(),
      client_secret: this.getClientSecret(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString();

    return this._httpsPost(GOOGLE_TOKEN_URL, body);
  }

  async getValidAccessToken(accountEmail = null) {
    const tokens = accountEmail
      ? this.databaseManager.getGoogleTokensByEmail(accountEmail)
      : this.databaseManager.getGoogleTokens();
    if (!tokens)
      throw new Error(`No Google tokens found${accountEmail ? ` for ${accountEmail}` : ""}`);

    const fiveMinutes = 5 * 60 * 1000;
    if (tokens.expires_at - fiveMinutes < Date.now()) {
      const refreshed = await this.refreshAccessToken(tokens.refresh_token);
      if (refreshed.error) {
        throw new Error(`Token refresh failed: ${refreshed.error_description || refreshed.error}`);
      }

      const newExpiresAt = Date.now() + refreshed.expires_in * 1000;
      this.databaseManager.saveGoogleTokens({
        google_email: tokens.google_email,
        access_token: refreshed.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: newExpiresAt,
        scope: tokens.scope,
      });

      return refreshed.access_token;
    }

    return tokens.access_token;
  }

  async revokeToken(token) {
    const body = new URLSearchParams({ token }).toString();
    try {
      await this._httpsPost("https://oauth2.googleapis.com/revoke", body);
    } catch {
      // Best-effort — token may already be revoked or network unavailable
    }
  }

  _httpsPost(urlString, body) {
    const url = new URL(urlString);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname,
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = GoogleCalendarOAuth;
