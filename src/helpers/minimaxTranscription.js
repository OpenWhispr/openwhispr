const debugLogger = require("./debugLogger");
const { convertBufferToWav, isWavFormat } = require("./ffmpegUtils");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

const MINIMAX_STT_URL = "https://api.minimax.io/v1/speech_to_text";
const MINIMAX_STT_MODEL = "asr-1.0";

// MiniMax rejects MediaRecorder WebM ("duration is N/A"), so WebM goes out as
// 16 kHz WAV; every other upload container is one it accepts as-is.
const NEEDS_WAV = new Set(["audio/webm", "video/webm"]);

// shortcut: no chunking, so uploads over MiniMax's 500 s / 50 MB cap fail with
// the provider's error; split through splitAudioFile if long uploads matter.
async function transcribeWithMinimax({
  audioBuffer,
  fileName,
  contentType,
  language,
  diarize = false,
  apiKey,
  fetchImpl = fetch,
}) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "MiniMax",
      surface: "transcription",
    });
  }

  let body = audioBuffer;
  let type = contentType;
  let name = fileName;
  if (NEEDS_WAV.has(contentType) && !isWavFormat(Buffer.from(audioBuffer))) {
    body = await convertBufferToWav(Buffer.from(audioBuffer));
    type = "audio/wav";
    name = "audio.wav";
  }

  const formData = new FormData();
  formData.append("file", new Blob([body], { type }), name);
  formData.append("model", MINIMAX_STT_MODEL);
  formData.append("response_format", diarize ? "verbose_json" : "json");

  const headers = { Authorization: `Bearer ${apiKey}` };
  // MiniMax takes the language as a header, not a form field; omitted = auto-detect.
  if (language && language !== "auto") headers.language = language;

  const response = await fetchImpl(MINIMAX_STT_URL, { method: "POST", headers, body: formData });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("MiniMax transcription failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: "MiniMax",
      model: MINIMAX_STT_MODEL,
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const data = await response.json();
  const result = { text: data?.text || "", model: MINIMAX_STT_MODEL };
  if (diarize && Array.isArray(data?.segments)) {
    result.segments = data.segments.map((s) => ({
      speaker: s.speaker || "Speaker ?",
      text: s.text || "",
      start: s.start || 0,
      end: s.end || 0,
    }));
  }
  return result;
}

module.exports = { MINIMAX_STT_MODEL, transcribeWithMinimax };
