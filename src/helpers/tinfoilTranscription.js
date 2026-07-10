const debugLogger = require("./debugLogger");
const modelRegistryData = require("../models/modelRegistryData.json");
const { tinfoilSecureFetch } = require("./tinfoilSecureClient");

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
    const error = new Error("Tinfoil API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
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

  if (response.status === 401) {
    const error = new Error("Invalid Tinfoil API key. Check your key in Settings.");
    error.code = "INVALID_KEY";
    throw error;
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`Tinfoil API Error: ${response.status} ${errorText}`.trim());
    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }
    throw error;
  }

  const data = await response.json();
  return { text: data?.text || "", model };
}

module.exports = { transcribeWithTinfoil };
