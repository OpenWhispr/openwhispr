// 60db's native STT API takes multipart file/language/context, not an
// OpenAI model or response_format. Keep dictation, retry and upload identical.
const SIXTYDB_STT_URL = "https://api.60db.ai/stt";
const SIXTYDB_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function transcribeWithSixtyDB(
  { audioBuffer, apiKey, language, context, fileName = "audio.webm", contentType = "audio/webm" },
  fetchImpl
) {
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw Object.assign(new Error("60db API key not configured. Add your key in Settings."), {
      code: "API_KEY_MISSING",
    });
  }
  if (!(audioBuffer instanceof ArrayBuffer) && !Buffer.isBuffer(audioBuffer)) {
    throw new Error("Invalid 60db audio buffer");
  }
  if (!audioBuffer.byteLength || audioBuffer.byteLength > SIXTYDB_MAX_AUDIO_BYTES) {
    throw new Error("60db requires a non-empty audio file of at most 10 MB");
  }

  const body = new FormData();
  body.append("file", new Blob([audioBuffer], { type: contentType }), fileName);
  if (language && language !== "auto") {
    if (typeof language !== "string" || !/^[a-z]{2}(?:-[a-zA-Z]+)?$/.test(language)) {
      throw new Error("Invalid 60db language code");
    }
    body.append("language", language.split("-")[0]);
  }
  if (context !== undefined) {
    if (typeof context !== "string") throw new Error("Invalid 60db context");
    if (context.trim()) body.append("context", context.trim());
  }

  const doFetch =
    fetchImpl ||
    ((url, init) => require("electron").net.fetch(url, { ...init, useSessionCookies: false }));
  let response;
  try {
    response = await doFetch(SIXTYDB_STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("60db transcription request failed or timed out");
  }
  if (!response.ok) {
    const code =
      response.status === 401 || response.status === 403
        ? "INVALID_KEY"
        : response.status === 429
          ? "PROVIDER_RATE_LIMITED"
          : response.status >= 500
            ? "SERVER_ERROR"
            : undefined;
    // Never include provider response bodies: they may echo audio or credentials.
    const error = new Error(`60db transcription failed (HTTP ${response.status})`);
    if (code) error.code = code;
    if (code === "PROVIDER_RATE_LIMITED") {
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    }
    throw error;
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Invalid 60db transcription response");
  }
  if (data?.success === false || typeof data?.text !== "string") {
    throw new Error("Invalid 60db transcription response");
  }
  // Empty text is a valid no-speech response; callers own their no-speech UX.
  return { text: data.text, model: "sixtydb-stt" };
}

module.exports = { transcribeWithSixtyDB };
