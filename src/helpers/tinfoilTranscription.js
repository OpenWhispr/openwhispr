const debugLogger = require("./debugLogger");
const modelRegistryData = require("../models/modelRegistryData.json");
const { tinfoilSecureFetch } = require("./tinfoilSecureClient");

const TINFOIL_TRANSCRIPTION_PATH = "/v1/audio/transcriptions";

/**
 * Tinfoil's dictation model is realtime-only, so every batch path — retry, audio
 * upload, and any fallback out of a streaming session — needs a different model.
 */
function getBatchModel() {
  const provider = (modelRegistryData.transcriptionProviders || []).find((p) => p.id === "tinfoil");
  const model = provider?.batchModel;
  if (!model) {
    throw new Error("No batch transcription model configured for Tinfoil");
  }
  return model;
}

/**
 * Batch transcription over the attested transport. Shares the one SecureClient
 * with realtime dictation and the model catalog, so the enclave is verified once
 * per session and the API key travels per-request.
 */
async function transcribeWithTinfoil({ audioBuffer, fileName, contentType, language, apiKey }) {
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
    throw new Error(`Tinfoil API Error: ${response.status} ${errorText}`.trim());
  }

  const data = await response.json();
  return { text: data?.text || "", model };
}

module.exports = { transcribeWithTinfoil };
