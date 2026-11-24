const { net } = require("electron");
const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

// AI Gateway has no OpenAI-compatible /audio/transcriptions route: speech-to-text
// is its own endpoint, taking base64 audio in JSON and the model id in a header,
// so a Custom base URL can't reach it and it is proxied through main.
const VERCEL_GATEWAY_TRANSCRIPTION_URL = "https://ai-gateway.vercel.sh/v4/ai/transcription-model";
const DEFAULT_MODEL = "openai/gpt-transcribe";
const PROVIDER_NAME = "Vercel AI Gateway";

async function transcribeWithVercelGateway(
  { audioBuffer, model, contentType, apiKey, signal },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: PROVIDER_NAME,
      surface: "transcription",
    });
  }

  const resolvedModel = model || DEFAULT_MODEL;
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);

  debugLogger.debug(
    "Vercel AI Gateway batch transcription starting",
    { model: resolvedModel, audioBytes: buffer.byteLength },
    "transcription"
  );

  signal?.throwIfAborted();
  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const response = await doFetch(VERCEL_GATEWAY_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
      "ai-gateway-protocol-version": "0.0.1",
      "ai-transcription-model-specification-version": "4",
      "ai-model-id": resolvedModel,
    },
    // No language or dictionary: those are providerOptions keyed by the upstream
    // vendor, and the gateway may route one model id to more than one of them.
    body: JSON.stringify({
      audio: buffer.toString("base64"),
      mediaType: (contentType || "audio/webm").split(";")[0].trim(),
    }),
    // The endpoint is fixed and never redirects; following one would carry the key
    // and the recording to whichever host it names.
    redirect: "error",
    ...(signal ? { signal } : {}),
  });

  if (!response.ok) {
    const errorText = await response.text().catch((error) => {
      if (error.name === "AbortError") throw error;
      return "";
    });
    signal?.throwIfAborted();
    debugLogger.warn("Vercel AI Gateway transcription failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: PROVIDER_NAME,
      model: resolvedModel,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const data = await response.json().catch((error) => {
    if (error instanceof SyntaxError) return null;
    throw error;
  });
  if (typeof data?.text !== "string") {
    throw providerError(PROVIDER_ERROR_CODES.ERROR, {
      provider: PROVIDER_NAME,
      surface: "transcription",
      technicalDetails: { underlyingError: "Expected a JSON transcript with a text field." },
    });
  }
  // Silence comes back as a 200 with an empty text.
  return { text: data.text.trim() ? data.text : "", model: resolvedModel };
}

module.exports = { transcribeWithVercelGateway, VERCEL_GATEWAY_TRANSCRIPTION_URL };
