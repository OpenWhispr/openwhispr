const debugLogger = require("./debugLogger");

const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const XAI_TTS_VOICES_URL = "https://api.x.ai/v1/tts/voices";
const XAI_CUSTOM_VOICES_URL = "https://api.x.ai/v1/custom-voices";
const MAX_TEXT_CHARS = 15000;
const SPEED_MIN = 0.7;
const SPEED_MAX = 1.5;
const REQUEST_TIMEOUT_MS = 60_000;

const FALLBACK_VOICES = [
  { voiceId: "carina", name: "Carina", language: "en", source: "default" },
  { voiceId: "atlas", name: "Atlas", language: "en", source: "default" },
  { voiceId: "aurora", name: "Aurora", language: "en", source: "default" },
  { voiceId: "castor", name: "Castor", language: "en", source: "default" },
  { voiceId: "celeste", name: "Celeste", language: "en", source: "default" },
  { voiceId: "eve", name: "Eve", language: "en", source: "default" },
];

class TtsRequestError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.errorCode = errorCode;
  }
}

function clampSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, n));
}

function parseVoices(payload, source) {
  const voices = payload?.voices;
  if (!Array.isArray(voices)) return [];
  return voices
    .filter((voice) => typeof voice?.voice_id === "string" && voice.voice_id.trim())
    .map((voice) => ({
      voiceId: voice.voice_id.trim(),
      name:
        typeof voice.name === "string" && voice.name.trim() ? voice.name.trim() : voice.voice_id,
      language: typeof voice.language === "string" ? voice.language : "",
      gender: typeof voice.gender === "string" ? voice.gender : "",
      source,
    }));
}

function buildTtsBody(input = {}) {
  const text = String(input.text || "").trim();
  if (!text) {
    throw new TtsRequestError("textRequired", "Enter text to convert.");
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw new TtsRequestError("textTooLong", `Text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  const codec = String(input.codec || "mp3").toLowerCase();
  const sampleRate = Number(input.sampleRate) || 24000;
  const outputFormat = { codec, sample_rate: sampleRate };
  if (codec === "mp3") {
    outputFormat.bit_rate = Number(input.bitRate) || 128000;
  }

  const latency = Number(input.optimizeStreamingLatency);
  const body = {
    text,
    voice_id: String(input.voiceId || "eve").trim() || "eve",
    language: String(input.language || "auto").trim() || "auto",
    speed: clampSpeed(input.speed),
    optimize_streaming_latency: latency === 0 || latency === 1 || latency === 2 ? latency : 1,
    text_normalization: Boolean(input.textNormalization),
    with_timestamps: Boolean(input.withTimestamps),
    output_format: outputFormat,
  };
  return body;
}

async function authorizedFetch(url, { getBearer, fetchImpl, method = "GET", body, accept } = {}) {
  const token = typeof getBearer === "function" ? await getBearer() : "";
  if (!token) {
    throw new TtsRequestError("credentialsRequired", "xAI credentials not configured");
  }
  return fetchImpl(url, {
    method,
    headers: {
      Accept: accept || "application/json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function listXaiTtsVoices({ getBearer, fetchImpl = fetch } = {}) {
  try {
    const [defaultsRes, customRes] = await Promise.all([
      authorizedFetch(XAI_TTS_VOICES_URL, { getBearer, fetchImpl }),
      authorizedFetch(XAI_CUSTOM_VOICES_URL, { getBearer, fetchImpl }).catch(() => null),
    ]);
    if (!defaultsRes.ok) {
      throw new Error(`xAI voices request failed: ${defaultsRes.status}`);
    }
    const defaults = parseVoices(await defaultsRes.json(), "default");
    let custom = [];
    if (customRes?.ok) {
      custom = parseVoices(await customRes.json(), "custom");
    }
    const voices = [...custom, ...defaults];
    return voices.length > 0 ? voices : FALLBACK_VOICES;
  } catch (error) {
    debugLogger.warn("Failed to list xAI TTS voices", { error: error.message });
    if (error.errorCode === "credentialsRequired") throw error;
    return FALLBACK_VOICES;
  }
}

async function synthesizeXaiTts({ getBearer, fetchImpl = fetch, input } = {}) {
  let body;
  try {
    body = buildTtsBody(input);
  } catch (error) {
    return {
      success: false,
      errorCode: error.errorCode || "invalidRequest",
      error: error.message,
    };
  }

  try {
    const response = await authorizedFetch(XAI_TTS_URL, {
      getBearer,
      fetchImpl,
      method: "POST",
      body: JSON.stringify(body),
      accept: "*/*",
    });
    if (!response.ok) {
      const detail = await response.text();
      debugLogger.warn("xAI TTS request rejected", {
        status: response.status,
        detail: detail.slice(0, 200),
      });
      return {
        success: false,
        errorCode:
          response.status === 401 || response.status === 403
            ? "credentialsRejected"
            : "providerStatus",
        error: `xAI TTS failed: ${response.status}`,
        status: response.status,
      };
    }

    const contentType = response.headers.get("content-type") || "audio/mpeg";
    if (contentType.includes("application/json")) {
      const payload = await response.json();
      const audio = typeof payload?.audio === "string" ? payload.audio : "";
      if (!audio) {
        return { success: false, errorCode: "emptyAudio", error: "xAI returned no audio." };
      }
      return { success: true, audioBase64: audio, contentType: "audio/mpeg" };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      success: true,
      audioBase64: buffer.toString("base64"),
      contentType: contentType.split(";")[0] || "audio/mpeg",
    };
  } catch (error) {
    if (error.errorCode === "credentialsRequired") {
      return { success: false, errorCode: "credentialsRequired", error: error.message };
    }
    debugLogger.warn("xAI TTS request failed", { error: error.message });
    return { success: false, errorCode: "network", error: "The provider could not be reached." };
  }
}

module.exports = {
  MAX_TEXT_CHARS,
  FALLBACK_VOICES,
  buildTtsBody,
  parseVoices,
  listXaiTtsVoices,
  synthesizeXaiTts,
  XAI_TTS_URL,
};
