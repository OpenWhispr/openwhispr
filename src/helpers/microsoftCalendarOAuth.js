const { net } = require("electron");
const { runOAuthLoopbackFlow, OAuthFlowError } = require("./oauthLoopbackFlow");

// The "common" tenant covers both work/school (M365) and personal
// (outlook.com) accounts. Desktop apps are public clients: PKCE, no secret.
const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
// "profile" puts preferred_username in the id_token and User.Read allows the
// GET /me fallback — work accounts often omit the "email" claim.
const CALENDAR_SCOPE =
  "openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read";

class MicrosoftCalendarOAuth {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
  }

  getClientId() {
    return process.env.MICROSOFT_CALENDAR_CLIENT_ID;
  }

  startOAuthFlow() {
    return runOAuthLoopbackFlow({
      errorParam: "mcal_error",
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: this.getClientId(),
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CALENDAR_SCOPE,
          // Without this, SSO silently re-links the signed-in account when
          // the user tries to add another one.
          prompt: "select_account",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        return `${MICROSOFT_AUTH_URL}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const tokenData = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);

        if (tokenData.error) {
          throw new OAuthFlowError(
            "token_exchange_failed",
            `Token exchange failed: ${tokenData.error_description || tokenData.error}`
          );
        }

        const email = await this._resolveEmail(tokenData);
        if (!email) {
          throw new OAuthFlowError(
            "no_email",
            "Could not extract email from Microsoft OAuth response"
          );
        }

        this._saveTokens(email, tokenData);
        return { success: true, email };
      },
    });
  }

  async exchangeCodeForTokens(code, redirectUri, codeVerifier) {
    const body = new URLSearchParams({
      code,
      client_id: this.getClientId(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString();

    return this._httpsPost(MICROSOFT_TOKEN_URL, body);
  }

  async refreshAccessToken(refreshToken) {
    const body = new URLSearchParams({
      client_id: this.getClientId(),
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: CALENDAR_SCOPE,
    }).toString();

    return this._httpsPost(MICROSOFT_TOKEN_URL, body);
  }

  async getValidAccessToken(accountEmail) {
    const tokens = this.databaseManager.getMicrosoftTokensByEmail(accountEmail);
    if (!tokens) throw new Error(`No Microsoft tokens found for ${accountEmail}`);

    const fiveMinutes = 5 * 60 * 1000;
    if (tokens.expires_at - fiveMinutes < Date.now()) {
      const refreshed = await this.refreshAccessToken(tokens.refresh_token);
      if (refreshed.error) {
        throw new Error(`Token refresh failed: ${refreshed.error_description || refreshed.error}`);
      }

      // Microsoft rotates refresh tokens on every refresh; persist the new one
      // or the old refresh token stops working within 24h.
      this._saveTokens(tokens.microsoft_email, {
        ...refreshed,
        refresh_token: refreshed.refresh_token || tokens.refresh_token,
        scope: refreshed.scope || tokens.scope,
      });

      return refreshed.access_token;
    }

    return tokens.access_token;
  }

  _saveTokens(email, tokenData) {
    this.databaseManager.saveMicrosoftTokens({
      microsoft_email: email,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + tokenData.expires_in * 1000,
      scope: tokenData.scope || CALENDAR_SCOPE,
    });
  }

  // Work accounts often omit the id_token "email" claim; fall back to
  // preferred_username, then Graph /me.
  async _resolveEmail(tokenData) {
    if (tokenData.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(tokenData.id_token.split(".")[1], "base64url").toString()
        );
        if (payload.email) return payload.email;
        if (payload.preferred_username?.includes("@")) return payload.preferred_username;
      } catch {}
    }

    try {
      const response = await net.fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10000),
        useSessionCookies: false,
      });
      const me = await response.json();
      return me.mail || me.userPrincipalName || null;
    } catch {
      return null;
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

module.exports = MicrosoftCalendarOAuth;
