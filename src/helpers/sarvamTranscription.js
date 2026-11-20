const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { convertToPcm16 } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { mapVerboseSegments } = require("./uploadTimestamps");
const { pcm16ToWav } = require("../utils/audioUtils");
const { resolveSarvamMode, sarvamKeyterms, sarvamLanguage } = require("../utils/sarvam");
const {
  asProviderError,
  providerError,
  providerHttpError,
  PROVIDER_ERROR_CODES,
} = require("./providerHttpErrors");

const SARVAM_URL = "https://api.sarvam.ai/speech-to-text";
const BYTES_PER_SECOND = 16000 * 2;
const MAX_BYTES = 30 * BYTES_PER_SECOND;

// Prefer a pause in the last two seconds of a long piece. Keep each PCM frame exactly once.
function boundary(pcm) {
  const frameSize = BYTES_PER_SECOND / 50;
  let quietest = Infinity;
  let cut = 29 * BYTES_PER_SECOND;
  for (let start = 27 * BYTES_PER_SECOND; start < 29 * BYTES_PER_SECOND; start += frameSize) {
    let power = 0;
    for (let i = start; i < start + frameSize; i += 2) power += pcm.readInt16LE(i) ** 2;
    if (power <= quietest) {
      quietest = power;
      cut = start + frameSize;
    }
  }
  return cut;
}

function phraseSegments(text, timestamps, offset, duration) {
  const { words, start_time_seconds: starts, end_time_seconds: ends } = timestamps || {};
  if (
    !Array.isArray(words) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    starts.length !== words.length ||
    ends.length !== words.length
  )
    return null;
  const segments = [];
  for (const [index, phrase] of words.entries()) {
    const start = starts[index];
    const end = ends[index];
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      end > duration
    )
      return null;
    if (index > 0 && (start < starts[index - 1] || end < ends[index - 1])) return null;
    segments.push({ text: phrase, start: offset + start, end: offset + end });
  }
  return mapVerboseSegments({ text, segments });
}

async function sendPiece(
  pcm,
  { apiKey, model, language, keyterms, sarvamMode, timestamps, signal, fetchImpl, maxRetryWaitMs }
) {
  const form = new FormData();
  form.set("file", new Blob([pcm16ToWav(pcm)], { type: "audio/wav" }), "audio.wav");
  form.set("model", model);
  form.set("mode", sarvamMode);
  if (language) form.set("language_code", language);
  if (timestamps) form.set("with_timestamps", "true");
  if (keyterms.length) form.set("keyterms", JSON.stringify(keyterms));

  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(60_000);
    let wait = 500 * 2 ** attempt;
    let response;
    let body;
    try {
      response = await fetchImpl(SARVAM_URL, {
        method: "POST",
        redirect: "error",
        headers: { "api-subscription-key": apiKey },
        body: form,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      body = await response.text();
    } catch (error) {
      signal?.throwIfAborted();
      if (error?.code === "DEVICE_POLICY_BLOCKED") throw error;
      if (attempt >= 2)
        throw asProviderError(error, { provider: "Sarvam AI", surface: "transcription", model });
      await delay(wait, undefined, { signal });
      continue;
    }
    if (response.ok) {
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        // Checked below.
      }
      if (typeof data?.transcript !== "string")
        throw new Error("Sarvam AI returned an invalid transcript.");
      return data;
    }
    const retryable =
      (response.status === 429 && !body.includes("seat_budget_exhausted_error")) ||
      [408, 500, 502, 503, 504].includes(response.status);
    const after = response.headers.get("retry-after");
    if (after) {
      const ms = Number.isFinite(Number(after))
        ? Number(after) * 1000
        : Date.parse(after) - Date.now();
      if (Number.isFinite(ms)) wait = Math.max(wait, ms);
    }
    if (!retryable || attempt >= 2 || wait > maxRetryWaitMs)
      throw providerHttpError({
        provider: "Sarvam AI",
        surface: "transcription",
        model,
        status: response.status,
        headers: response.headers,
        body,
      });
    await delay(wait, undefined, { signal });
  }
}

async function transcribeWithSarvam({
  audioBuffer,
  filePath,
  apiKey,
  model = "saaras:v4",
  sarvamMode,
  language,
  keyterms,
  signal,
  fetchImpl = fetch,
  // A dictation is waiting on the paste; an upload can sit out a per-minute rate limit.
  maxRetryWaitMs = 10_000,
  onProgress,
  timestamps = false,
}) {
  if (!apiKey?.trim())
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "Sarvam AI",
      surface: "transcription",
    });
  if (!["saaras:v4", "saaras:v3"].includes(model)) throw new Error("Unsupported Sarvam model");
  signal?.throwIfAborted();
  const dir = await fs.mkdtemp(path.join(getSafeTempDir(), "ow-sarvam-"));
  try {
    let input = filePath;
    if (!input) {
      input = path.join(dir, "recording");
      await fs.writeFile(input, Buffer.from(audioBuffer));
    }
    // Sample count stays exact even for streaming WebM without a duration header.
    const pcmPath = path.join(dir, "recording.pcm");
    await convertToPcm16(input, pcmPath, { signal });
    const pcm = await fs.open(pcmPath);
    try {
      const { size } = await pcm.stat();
      const fields = {
        apiKey,
        model,
        sarvamMode: resolveSarvamMode(sarvamMode),
        language: sarvamLanguage(language),
        keyterms: model === "saaras:v4" ? sarvamKeyterms(keyterms) : [],
        signal,
        fetchImpl,
        maxRetryWaitMs,
        timestamps,
      };
      const parts = [];
      let segments = timestamps ? [] : null;
      let position = 0;
      // Cut points depend on the audio, so the total firms up as pieces are sent.
      const reportProgress = () =>
        onProgress?.({
          stage: "transcribing",
          chunksTotal: parts.length + Math.ceil((size - position) / MAX_BYTES),
          chunksCompleted: parts.length,
        });
      reportProgress();
      while (position < size) {
        signal?.throwIfAborted();
        const chunk = Buffer.alloc(Math.min(MAX_BYTES, size - position));
        let read = 0;
        while (read < chunk.length) {
          const { bytesRead } = await pcm.read(chunk, read, chunk.length - read, position + read);
          if (!bytesRead) throw new Error("Incomplete Sarvam audio segment");
          read += bytesRead;
        }
        const length = size - position > MAX_BYTES ? boundary(chunk) : chunk.length;
        const piece = await sendPiece(chunk.subarray(0, length), fields);
        const text = piece.transcript.trim();
        parts.push(text);
        if (segments && text) {
          const phrases = phraseSegments(
            text,
            piece.timestamps,
            position / BYTES_PER_SECOND,
            length / BYTES_PER_SECOND
          );
          // The saved note uses the segments as its transcript, so none of the words can be missing.
          if (phrases) segments.push(...phrases);
          else segments = null;
        }
        position += length;
        reportProgress();
      }
      signal?.throwIfAborted();
      const text = parts.filter(Boolean).join(" ");
      if (!text)
        throw Object.assign(new Error("No speech detected in audio"), {
          code: "NO_SPEECH_DETECTED",
        });
      return segments ? { text, segments } : { text };
    } finally {
      await pcm.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

module.exports = { transcribeWithSarvam };
