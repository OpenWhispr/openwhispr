const { net } = require("electron");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { getCortiToken } = require("./cortiAuth");

const CORTI_PRIVACY_CLEANUP_TIMEOUT_MS = 5000;

function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason) throw signal.reason;
  const error = new Error("Corti transcription cancelled");
  error.name = "AbortError";
  throw error;
}

async function request(token, tenant, url, options = {}) {
  assertNotAborted(options.signal);
  const { acceptNotFound = false, ...requestOptions } = options;
  const response = await net.fetch(url, {
    ...requestOptions,
    headers: {
      Authorization: `Bearer ${token}`,
      "Tenant-Name": tenant,
      ...options.headers,
    },
  });
  assertNotAborted(options.signal);
  if (!response.ok && !(acceptNotFound && response.status === 404)) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Corti API Error: ${response.status} ${errorText}`.trim());
  }
  return response;
}

async function requestJson(token, tenant, url, options) {
  const data = await (await request(token, tenant, url, options)).json();
  assertNotAborted(options?.signal);
  return data;
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
  signal,
  onCleanupFailure,
}) {
  assertNotAborted(signal);
  const token = await getCortiToken({ environment, tenant, clientId, clientSecret, signal });
  assertNotAborted(signal);
  const base = `https://api.${environment}.corti.app/v2`;

  debugLogger.debug(
    "Corti transcription starting",
    { environment, tenant, audioBytes: audioBuffer.byteLength, language },
    "transcription"
  );

  const { interactionId } = await requestJson(token, tenant, `${base}/interactions/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
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
        signal,
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
        signal,
      }
    );

    return { text: (transcript.transcripts || []).map((utterance) => utterance.text).join(" ") };
  } finally {
    // Dictation audio must not persist on Corti's servers — deleting the
    // interaction cascades to its recordings and transcripts.
    try {
      await request(token, tenant, `${base}/interactions/${interactionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(CORTI_PRIVACY_CLEANUP_TIMEOUT_MS),
        acceptNotFound: true,
      });
    } catch (error) {
      debugLogger.error(
        "Failed to delete Corti interaction",
        { interactionId, error: error.message },
        "transcription"
      );
      try {
        await onCleanupFailure?.({ environment, tenant, interactionId });
      } catch (persistError) {
        debugLogger.error(
          "Failed to persist Corti privacy cleanup retry",
          { interactionId, error: persistError.message },
          "transcription"
        );
      }
    }
  }
}

async function deleteCortiInteraction({
  environment,
  tenant,
  interactionId,
  clientId,
  clientSecret,
}) {
  const signal = AbortSignal.timeout(CORTI_PRIVACY_CLEANUP_TIMEOUT_MS);
  const token = await getCortiToken({ environment, tenant, clientId, clientSecret, signal });
  await request(
    token,
    tenant,
    `https://api.${environment}.corti.app/v2/interactions/${interactionId}`,
    { method: "DELETE", signal, acceptNotFound: true }
  );
}

module.exports = { deleteCortiInteraction, transcribeAudio };
