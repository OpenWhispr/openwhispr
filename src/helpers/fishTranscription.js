const { net } = require("electron");

// Fish ASR is not OpenAI-compatible: audio is a file field, model is a header.
// https://docs.fish.audio/api-reference/endpoint/openapi-v1/speech-to-text
const FISH_ASR_URL = "https://api.fish.audio/v1/asr";

async function transcribeWithFish(
  { audioBuffer, apiKey, model, contentType = "audio/wav", fileName = "audio.wav", language },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    const error = new Error("Fish Audio API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  // Unknown headers silently select the legacy model on the server.
  const resolvedModel = model?.trim() === "transcribe-1" ? "transcribe-1" : "transcribe-1-pro";
  const form = new FormData();
  if (resolvedModel === "transcribe-1" && /(?:webm|matroska|quicktime)/i.test(contentType)) {
    const { convertBufferToWav } = require("./ffmpegUtils");
    audioBuffer = await convertBufferToWav(audioBuffer);
    contentType = "audio/wav";
    fileName = "audio.wav";
  }
  if (audioBuffer.byteLength > 25 * 1024 * 1024) {
    throw new Error("Audio exceeds the 25 MB Fish Audio upload limit in OpenWhispr.");
  }
  form.append("audio", new Blob([audioBuffer], { type: contentType }), fileName);
  form.append("ignore_timestamps", "true");
  if (language && language !== "auto") {
    form.append("language", language.split("-")[0].toLowerCase());
  }
  if (resolvedModel === "transcribe-1-pro") {
    form.append("tag_audio_events", "false");
    form.append("diarize", "false");
  }

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const response = await doFetch(FISH_ASR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, model: resolvedModel },
    body: form,
  });

  if (!response.ok) {
    // Edge errors may be HTML; never echo untrusted response bodies or credentials.
    const error = new Error(`Fish Audio API Error: ${response.status}`);
    if (response.status === 401 || response.status === 403) {
      error.message = "Invalid Fish Audio API key. Check your key in Settings.";
      error.code = "INVALID_KEY";
    } else if (response.status === 402) {
      error.message = "Insufficient Fish Audio API credit. Check your Fish Audio balance.";
    } else if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }
    throw error;
  }

  const data = await response.json();
  if (typeof data?.text !== "string") {
    throw new Error("Fish Audio returned an invalid transcription response.");
  }
  // diarize=false only removes speaker_turns, not inline speaker tokens.
  return { text: data.text.replace(/<\|speaker:\d+\|>\s*/g, "").trim(), model: resolvedModel };
}

module.exports = { transcribeWithFish };
