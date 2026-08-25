const { net } = require("electron");
const { runOAuthLoopbackFlow, OAuthFlowError } = require("./oauthLoopbackFlow");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
// gmail.send is Google's only sensitive-tier Gmail scope — adding any read or
// compose scope reclassifies the app as restricted (annual CASA audit).
const GMAIL_SCOPE = "openid email https://www.googleapis.com/auth/gmail.send";

class GmailOAuth {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
  }

  getClientId() {
    return process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CALENDAR_CLIENT_ID;
  }

  getClientSecret() {
    return process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  }

  isConfigured() {
    return Boolean(this.getClientId() && this.getClientSecret());
  }

  startOAuthFlow() {
    if (!this.isConfigured()) {
      // Fail fast instead of opening the browser on a client_id=undefined URL
      // and hanging until the loopback flow times out.
      throw new Error("Gmail OAuth client is not configured");
    }
    return runOAuthLoopbackFlow({
      errorParam: "gmail_error",
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: this.getClientId(),
          redirect_uri: redirectUri,
          response_type: "code",
          scope: GMAIL_SCOPE,
          access_type: "offline",
          prompt: "consent",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        return `${GOOGLE_AUTH_URL}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const tokenData = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);

        if (tokenData.error) {
          throw new OAuthFlowError(
            "token_exchange_failed",
            `Token exchange failed: ${tokenData.error_description || tokenData.error}`
          );
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
          throw new OAuthFlowError(
            "no_email",
            "Could not extract email from Google OAuth response"
          );
        }

        this.databaseManager.saveGmailTokens({
          gmail_email: email,
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token,
          expires_at: Date.now() + tokenData.expires_in * 1000,
          scope: tokenData.scope || GMAIL_SCOPE,
        });

        return { success: true, email };
      },
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

  async getValidAccessToken() {
    const tokens = this.databaseManager.getGmailTokens();
    if (!tokens) throw new Error("No Gmail tokens found");

    const fiveMinutes = 5 * 60 * 1000;
    if (tokens.expires_at - fiveMinutes < Date.now()) {
      const refreshed = await this.refreshAccessToken(tokens.refresh_token);
      if (refreshed.error) {
        throw new Error(`Token refresh failed: ${refreshed.error_description || refreshed.error}`);
      }

      this.databaseManager.saveGmailTokens({
        gmail_email: tokens.gmail_email,
        access_token: refreshed.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + refreshed.expires_in * 1000,
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

  async _httpsPost(urlString, body) {
    const response = await net.fetch(urlString, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
  }
}

module.exports = GmailOAuth;
