const { net } = require("electron");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { getCortiToken } = require("./cortiAuth");

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

async function requestJson(token, tenant, url, options) {
  return (await request(token, tenant, url, options)).json();
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
  const token = await getCortiToken({ environment, tenant, clientId, clientSecret });
  const base = `https://api.${environment}.corti.app/v2`;

  debugLogger.debug(
    "Corti transcription starting",
    { environment, tenant, audioBytes: audioBuffer.byteLength, language },
    "transcription"
  );

  const { interactionId } = await requestJson(token, tenant, `${base}/interactions/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      encounter: {
        identifier: `openwhispr-${crypto.randomUUID()}`,
        status: "completed",
        type: "consultation",
      },
    }),
  });

  try {
    const { recordingId } = await requestJson(
      token,
      tenant,
      `${base}/interactions/${interactionId}/recordings/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from(audioBuffer),
      }
    );

    const transcript = await requestJson(
      token,
      tenant,
      `${base}/interactions/${interactionId}/transcripts/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId, primaryLanguage: language, isDictation: true }),
      }
    );

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
