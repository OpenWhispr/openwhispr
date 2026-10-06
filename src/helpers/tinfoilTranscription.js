const debugLogger = require("./debugLogger");
const modelRegistryData = require("../models/modelRegistryData.json");
const { tinfoilSecureFetch } = require("./tinfoilSecureClient");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

const TINFOIL_TRANSCRIPTION_PATH = "/v1/audio/transcriptions";

// "Voxtral" is one picker choice but two Tinfoil models: the realtime one streams
// over /v1/realtime; this batch model handles every non-streaming path.
function getBatchModel() {
  const provider = (modelRegistryData.transcriptionProviders || []).find((p) => p.id === "tinfoil");
  const model = provider?.batchModel;
  if (!model) {
    throw new Error("No batch transcription model configured for Tinfoil");
  }
  return model;
}

// Batch transcription over the attested transport, sharing the per-session
// SecureClient with realtime dictation so the enclave is verified once.
async function transcribeWithTinfoil({
  audioBuffer,
  fileName,
  contentType,
  language,
  prompt,
  apiKey,
}) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "Tinfoil",
      surface: "transcription",
    });
  }

  const model = getBatchModel();
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: contentType }), fileName);
  formData.append("model", model);
  if (language && language !== "auto") {
    formData.append("language", language);
  }
  if (prompt?.trim()) {
    formData.append("prompt", prompt.trim());
  }

  debugLogger.debug("Tinfoil batch transcription starting", { model, language }, "transcription");

  const response = await tinfoilSecureFetch(TINFOIL_TRANSCRIPTION_PATH, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("Tinfoil transcription failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: "Tinfoil",
      model,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const data = await response.json();
  return { text: data?.text || "", model };
}

module.exports = { transcribeWithTinfoil };
