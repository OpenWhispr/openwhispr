const debugLogger = require("./debugLogger");

const TOKEN_EXPIRY_BUFFER_MS = 30000;
const TRANSCRIPT_POLL_INTERVAL_MS = 2000;
const TRANSCRIPT_SYNC_TIMEOUT_MS = 27000; // Corti syncs up to 25s, poll after
const TRANSCRIPT_ASYNC_TIMEOUT_MS = 120000;

class CortiManager {
  constructor(environmentManager, cortiOAuth) {
    this.environmentManager = environmentManager;
    this.cortiOAuth = cortiOAuth;
    this.clientCredsCache = { token: null, expiresAt: 0 };
  }

  _getConfig() {
    const env = this.environmentManager.getCortiEnvironment();
    return {
      clientId: this.environmentManager.getCortiClientId(),
      clientSecret: this.environmentManager.getCortiClientSecret(),
      region: env.region,
      tenant: this.environmentManager.getCortiTenant() || env.defaultTenant,
    };
  }

  async _ensureToken() {
    // PKCE first — uses stored refresh token, no secret required
    if (this.cortiOAuth) {
      try {
        return await this.cortiOAuth.getValidAccessToken();
      } catch {
        // Fall through to client_credentials if a secret is configured
      }
    }

    // Client credentials fallback (secret must be set)
    const { clientId, clientSecret, region, tenant } = this._getConfig();
    if (!clientId || !clientSecret) {
      throw new Error(
        "Not connected to Corti. Connect via Settings or configure a Client Secret."
      );
    }
    return this._ensureClientCredsToken(clientId, clientSecret, region, tenant);
  }

  async _ensureClientCredsToken(clientId, clientSecret, region, tenant) {
    const configKey = `${clientId}:${region}:${tenant}`;
    if (
      this.clientCredsCache.token &&
      this.clientCredsCache.configKey === configKey &&
      Date.now() < this.clientCredsCache.expiresAt - TOKEN_EXPIRY_BUFFER_MS
    ) {
      return this.clientCredsCache.token;
    }

    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "openid",
    });

    const res = await fetch(
      `https://auth.${region}.corti.app/realms/${tenant}/protocol/openid-connect/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Corti token fetch failed (${res.status}): ${body}`);
    }

    const data = await res.json();
    this.clientCredsCache.token = data.access_token;
    this.clientCredsCache.expiresAt = Date.now() + (data.expires_in || 300) * 1000;
    this.clientCredsCache.configKey = configKey;
    debugLogger.debug("Corti client_credentials token fetched", { expiresIn: data.expires_in });
    return this.clientCredsCache.token;
  }

  _baseUrl() {
    const { region } = this._getConfig();
    return `https://api.${region}.corti.app/v2`;
  }

  async _request(method, path, body, token) {
    const { tenant } = this._getConfig();
    const url = `${this._baseUrl()}${path}`;

    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Tenant-Name": tenant,
      },
    };

    if (body instanceof Uint8Array || Buffer.isBuffer(body)) {
      options.headers["Content-Type"] = "application/octet-stream";
      options.body = body;
    } else if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }

    const res = await fetch(url, options);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Corti API ${method} ${path} failed (${res.status}): ${text}`);
    }

    const locationHeader = res.headers.get("location");
    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const json = await res.json();
      return { json, locationHeader };
    }

    return { json: null, locationHeader };
  }

  async _createInteraction(token) {
    const now = new Date().toISOString();
    const { json } = await this._request(
      "POST",
      "/interactions",
      {
        encounter: {
          identifier: `openwhispr-${Date.now()}`,
          status: "planned",
          type: "first_consultation",
          period: { startedAt: now, endedAt: now },
          title: "Dictation",
        },
      },
      token
    );
    if (!json?.interactionId) {
      throw new Error("Corti create interaction returned no interactionId");
    }
    debugLogger.debug("Corti interaction created", { interactionId: json.interactionId });
    return json.interactionId;
  }

  async _uploadRecording(interactionId, audioBuffer, token) {
    const { json } = await this._request(
      "POST",
      `/interactions/${interactionId}/recordings/`,
      Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer),
      token
    );
    if (!json?.recordingId) {
      throw new Error("Corti upload recording returned no recordingId");
    }
    debugLogger.debug("Corti recording uploaded", {
      interactionId,
      recordingId: json.recordingId,
    });
    return json.recordingId;
  }

  async _createTranscript(interactionId, recordingId, language, token) {
    const lang = language && language !== "auto" ? language : "en";
    const res = await fetch(
      `${this._baseUrl()}/interactions/${interactionId}/transcripts/`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Tenant-Name": this._getConfig().tenant,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ recordingId, primaryLanguage: lang, isDictation: true }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Corti create transcript failed (${res.status}): ${text}`);
    }

    const contentType = res.headers.get("content-type") || "";
    let json = null;
    if (contentType.includes("application/json")) {
      json = await res.json();
    }

    // Synchronous response — transcript may be completed already
    if (json?.status === "completed" && json?.text) {
      debugLogger.debug("Corti transcript completed synchronously");
      return { transcriptId: json.transcriptId || json.id, completed: true, text: json.text };
    }

    // May include Location header or transcriptId for async polling
    const locationHeader = res.headers.get("location");
    const transcriptId = json?.transcriptId || json?.id || _parseTranscriptIdFromLocation(locationHeader);

    debugLogger.debug("Corti transcript job started", {
      interactionId,
      transcriptId,
      status: json?.status,
    });
    return { transcriptId, completed: false, text: null };
  }

  async _pollTranscriptStatus(interactionId, transcriptId, token) {
    const deadline = Date.now() + TRANSCRIPT_ASYNC_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await _sleep(TRANSCRIPT_POLL_INTERVAL_MS);

      const { json } = await this._request(
        "GET",
        `/interactions/${interactionId}/transcripts/${transcriptId}/status`,
        undefined,
        token
      );

      debugLogger.debug("Corti transcript poll", { status: json?.status });

      if (json?.status === "completed") {
        return true;
      }
      if (json?.status === "failed") {
        throw new Error(`Corti transcript processing failed: ${json?.error || "unknown error"}`);
      }
    }

    throw new Error("Corti transcript polling timed out");
  }

  async _getTranscript(interactionId, transcriptId, token) {
    const { json } = await this._request(
      "GET",
      `/interactions/${interactionId}/transcripts/${transcriptId}`,
      undefined,
      token
    );

    // Extract plain text from transcript response
    if (typeof json?.text === "string") return json.text;

    // Some responses nest text in segments
    if (Array.isArray(json?.segments)) {
      return json.segments
        .map((s) => s.text || "")
        .join(" ")
        .trim();
    }

    if (typeof json?.transcript === "string") return json.transcript;

    debugLogger.warn("Corti getTranscript: unexpected response shape", { keys: Object.keys(json || {}) });
    return "";
  }

  async transcribeRecording(audioBuffer, options = {}) {
    const { language } = options;

    let token;
    try {
      token = await this._ensureToken();
    } catch (err) {
      debugLogger.error("Corti REST: token fetch failed", { error: err.message });
      return { success: false, error: err.message, message: err.message };
    }

    try {
      const interactionId = await this._createInteraction(token);
      const recordingId = await this._uploadRecording(interactionId, audioBuffer, token);
      const { transcriptId, completed, text: syncText } = await this._createTranscript(
        interactionId,
        recordingId,
        language,
        token
      );

      if (completed && syncText) {
        return { success: true, text: syncText, source: "corti-rest" };
      }

      if (!transcriptId) {
        throw new Error("Corti: no transcriptId returned from create transcript");
      }

      await this._pollTranscriptStatus(interactionId, transcriptId, token);
      const finalText = await this._getTranscript(interactionId, transcriptId, token);

      if (!finalText) {
        return { success: true, text: "", message: "No audio detected", source: "corti-rest" };
      }

      return { success: true, text: finalText, source: "corti-rest" };
    } catch (err) {
      debugLogger.error("Corti REST transcription failed", { error: err.message });
      return { success: false, error: err.message, message: err.message };
    }
  }

  async testConnection() {
    try {
      await this._ensureToken();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }
}

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _parseTranscriptIdFromLocation(locationHeader) {
  if (!locationHeader) return null;
  const parts = locationHeader.split("/");
  return parts[parts.length - 1] || null;
}

module.exports = CortiManager;
