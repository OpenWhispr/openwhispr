const { PROVIDER_ERROR_CODES, providerError, providerHttpError } = require("./providerHttpErrors");

const VOICE_PREVIEW_LIMIT = 300;

async function synthesizeGnaniPreview({ text, apiKey, signal, fetchImpl }) {
  const context = { provider: "GnaniAI", model: "timbre-v3.0", surface: "transcription" };
  if (!apiKey) throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, context);
  if (typeof text !== "string" || !text.trim() || text.length > VOICE_PREVIEW_LIMIT)
    throw new Error("Enter between 1 and 300 characters for the voice preview.");

  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  const response = await fetchImpl("https://api.vachana.ai/api/v1/tts/inference", {
    method: "POST",
    redirect: "error",
    signal: requestSignal,
    headers: { "Content-Type": "application/json", "X-API-Key-ID": apiKey },
    body: JSON.stringify({
      text: text.trim(),
      model: context.model,
      voice: "Shivani",
      language: "auto",
      audio_config: { container: "mp3", sample_rate: 24000 },
    }),
  });
  if (!response.ok)
    throw providerHttpError({ ...context, status: response.status, headers: response.headers });
  const audio = await response.arrayBuffer();
  requestSignal.throwIfAborted();
  if (!audio.byteLength) throw new Error("GnaniAI returned empty audio.");
  return { success: true, audio };
}

module.exports = { synthesizeGnaniPreview };
