const { net } = require("electron");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");

const CORTI_ENVIRONMENTS = new Set(["eu", "us"]);
const TENANT_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Corti access tokens live 5 minutes; refresh early so in-flight requests never race expiry.
const TOKEN_REFRESH_MARGIN_MS = 30_000;

let cachedToken = null;

function assertValidTarget(environment, tenant) {
  if (!CORTI_ENVIRONMENTS.has(environment)) {
    throw new Error(`Invalid Corti environment: ${environment}`);
  }
  if (!TENANT_PATTERN.test(tenant)) {
    throw new Error("Invalid Corti tenant name");
  }
}

async function getAccessToken({ environment, tenant, clientId, clientSecret }) {
  const cacheKey = `${environment}/${tenant}/${clientId}`;
  if (cachedToken?.key === cacheKey && Date.now() < cachedToken.expiresAt) {
    return cachedToken.value;
  }

  const response = await net.fetch(
    `https://auth.${environment}.corti.app/realms/${tenant}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "openid",
      }).toString(),
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Corti authentication failed: ${response.status} ${errorText}`.trim());
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error("Corti authentication failed: no access token in response");
  }

  cachedToken = {
    key: cacheKey,
    value: data.access_token,
    expiresAt: Date.now() + (data.expires_in || 300) * 1000 - TOKEN_REFRESH_MARGIN_MS,
  };
  return data.access_token;
}

async function request(token, tenant, url, options = {}) {
  const response = await net.fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Tenant-Name": tenant,
      ...options.headers,
    },
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Corti API Error: ${response.status} ${errorText}`.trim());
  }
  return response;
}

// Corti's WSS /transcribe endpoint is a strictly real-time engine — replaying a
// finished recording faster than real time drops audio. Pre-recorded dictation
// goes through the interaction REST flow instead: create → upload → transcribe.
async function transcribeAudio({
  environment,
  tenant,
  clientId,
  clientSecret,
  audioBuffer,
  language,
}) {
  assertValidTarget(environment, tenant);
  const token = await getAccessToken({ environment, tenant, clientId, clientSecret });
  const base = `https://api.${environment}.corti.app/v2`;

  debugLogger.debug(
    "Corti transcription starting",
    { environment, tenant, audioBytes: audioBuffer.byteLength, language },
    "transcription"
  );

  const { interactionId } = await (
    await request(token, tenant, `${base}/interactions/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        encounter: {
          identifier: `openwhispr-${crypto.randomUUID()}`,
          status: "completed",
          type: "consultation",
        },
      }),
    })
  ).json();

  try {
    const { recordingId } = await (
      await request(token, tenant, `${base}/interactions/${interactionId}/recordings/`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(audioBuffer),
      })
    ).json();

    const transcript = await (
      await request(token, tenant, `${base}/interactions/${interactionId}/transcripts/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId, primaryLanguage: language, isDictation: true }),
      })
    ).json();

    return { text: (transcript.transcripts || []).map((utterance) => utterance.text).join(" ") };
  } finally {
    // Dictation audio must not persist on Corti's servers — deleting the
    // interaction cascades to its recordings and transcripts.
    request(token, tenant, `${base}/interactions/${interactionId}`, { method: "DELETE" }).catch(
      (error) =>
        debugLogger.error(
          "Failed to delete Corti interaction",
          { interactionId, error: error.message },
          "transcription"
        )
    );
  }
}

module.exports = { transcribeAudio };
