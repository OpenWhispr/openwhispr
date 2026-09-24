const { net } = require("electron");
const debugLogger = require("./debugLogger");
const GmailOAuth = require("./gmailOAuth");
const { broadcastToWindows } = require("./windowBroadcast");

const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

// RFC 2047 B-encoding for header values that aren't printable ASCII.
function encodeHeaderValue(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

class GmailManager {
  constructor(databaseManager) {
    this.databaseManager = databaseManager;
    this.oauth = new GmailOAuth(databaseManager);
  }

  static buildRawMessage({ from, to, cc, subject, body }) {
    const headers = [
      `From: ${from}`,
      `To: ${to.join(", ")}`,
      ...(cc?.length ? [`Cc: ${cc.join(", ")}`] : []),
      `Subject: ${encodeHeaderValue(subject)}`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
    ];
    const encodedBody = Buffer.from(body, "utf8")
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n");
    const message = `${headers.join("\r\n")}\r\n\r\n${encodedBody}`;
    return Buffer.from(message, "utf8").toString("base64url");
  }

  async startOAuth() {
    const result = await this.oauth.startOAuthFlow();
    this._broadcastConnectionChanged();
    return result;
  }

  async revokeAllTokens() {
    try {
      const allTokens = this.databaseManager.getAllGmailTokens();
      await Promise.allSettled(allTokens.map((t) => this.oauth.revokeToken(t.access_token)));
    } catch (err) {
      debugLogger.error("Error revoking Gmail tokens", { error: err.message }, "gmail");
    }
    this.disconnect();
  }

  disconnect() {
    this.databaseManager.deleteGmailTokens();
    this._broadcastConnectionChanged();
  }

  getConnectionStatus() {
    const tokens = this.databaseManager.getGmailTokens();
    return {
      connected: Boolean(tokens),
      email: tokens?.gmail_email || null,
      configured: this.oauth.isConfigured(),
    };
  }

  async sendEmail({ to, cc, subject, body }) {
    const tokens = this.databaseManager.getGmailTokens();
    if (!tokens) throw new Error("Gmail is not connected");

    const accessToken = await this.oauth.getValidAccessToken();
    const raw = GmailManager.buildRawMessage({
      from: tokens.gmail_email,
      to,
      cc,
      subject,
      body,
    });

    const response = await net.fetch(GMAIL_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Error statuses can arrive with empty or non-JSON bodies; surface the
      // status below instead of masking it as a parse failure.
    }
    if (response.status >= 400) {
      const err = new Error(parsed?.error?.message || `Gmail API error ${response.status}`);
      err.statusCode = response.status;
      throw err;
    }
    if (parsed === null) {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }

    return { messageId: parsed.id };
  }

  _broadcastConnectionChanged() {
    broadcastToWindows("gmail-connection-changed", this.getConnectionStatus());
  }
}

module.exports = GmailManager;
