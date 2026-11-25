const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { convertToPcm16 } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const { mapVerboseSegments } = require("./uploadTimestamps");
const { pcm16ToWav } = require("../utils/audioUtils");
const { resolveSarvamMode, sarvamKeyterms, sarvamLanguage } = require("../utils/sarvam");
const {
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  assembleChunkTranscript,
  summarizeChunkResults,
} = require("./cloudChunkPolicy");
const {
  asProviderError,
  providerError,
  providerHttpError,
  PROVIDER_ERROR_CODES,
} = require("./providerHttpErrors");

const SARVAM_URL = "https://api.sarvam.ai/speech-to-text";
const BYTES_PER_SECOND = 16000 * 2;
const MAX_BYTES = 30 * BYTES_PER_SECOND;
// A phrase may end a few frames past its piece; anything later is not that piece's timing.
const PHRASE_END_TOLERANCE_SECONDS = 0.1;
// Statuses about one piece's request. Any other failure (a refused key, a spent
// budget, no answer, throttling past its waits) would fail every later piece too.
const PIECE_REJECTIONS = new Set([400, 413, 422]);

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
    const end = Math.min(ends[index], duration);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(ends[index]) ||
      start < 0 ||
      end < start ||
      ends[index] > duration + PHRASE_END_TOLERANCE_SECONDS
    )
      return null;
    if (index > 0 && (start < starts[index - 1] || ends[index] < ends[index - 1])) return null;
    segments.push({ text: phrase, start: offset + start, end: offset + end });
  }
  return mapVerboseSegments({ text, segments });
}

async function sendPiece(
  pcm,
  {
    apiKey,
    model,
    language,
    keyterms,
    sarvamMode,
    timestamps,
    signal,
    fetchImpl,
    maxRetryWaitMs,
    requestTimeoutMs,
  }
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
    const timeout = AbortSignal.timeout(requestTimeoutMs);
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
      // A request that hung until its timeout would most likely hang again.
      if (attempt >= 2 || timeout.aborted)
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
  // A dictation is waiting on the paste; an upload passes SARVAM_UPLOAD_LIMITS.
  maxRetryWaitMs = 10_000,
  requestTimeoutMs = 30_000,
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
    await convertToPcm16(input, pcmPath, { signal }).catch((error) => {
      if (error.code !== "FFMPEG_EMPTY_OUTPUT") throw error;
      throw Object.assign(new Error("No speech detected in audio"), {
        code: "NO_SPEECH_DETECTED",
      });
    });
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
        requestTimeoutMs,
        timestamps,
      };
      // One entry per piece: its text, SILENT_CHUNK, or null when it was lost.
      const results = [];
      const spans = [];
      let segments = timestamps ? [] : null;
      let position = 0;
      let firstLoss = null;
      let stoppedBy = null;
      // Cut points depend on the audio, so the total firms up as pieces are sent.
      const reportProgress = () =>
        onProgress?.({
          stage: "transcribing",
          chunksTotal: results.length + Math.ceil((size - position) / MAX_BYTES),
          chunksCompleted: results.length,
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
        spans.push({
          start: position / BYTES_PER_SECOND,
          end: (position + length) / BYTES_PER_SECOND,
        });
        let piece;
        try {
          piece = await sendPiece(chunk.subarray(0, length), fields);
        } catch (error) {
          signal?.throwIfAborted();
          if (error?.code === "DEVICE_POLICY_BLOCKED") throw error;
          results.push(null);
          position += length;
          if (!PIECE_REJECTIONS.has(error.status)) {
            stoppedBy = error;
            break;
          }
          firstLoss ??= error;
          reportProgress();
          continue;
        }
        const text = piece.transcript.trim();
        results.push(text ? { text } : SILENT_CHUNK);
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
      // Audio left unsent after a stop is lost too, in pieces of the longest size.
      for (; position < size; position += MAX_BYTES) {
        results.push(null);
        spans.push({
          start: position / BYTES_PER_SECOND,
          end: Math.min(position + MAX_BYTES, size) / BYTES_PER_SECOND,
        });
      }
      const { responses, failedChunks, silentChunks } = summarizeChunkResults(results);
      if (responses.length === 0) {
        if (stoppedBy) throw stoppedBy;
        if (silentChunks === results.length)
          throw Object.assign(new Error("No speech detected in audio"), {
            code: "NO_SPEECH_DETECTED",
          });
        throw firstLoss;
      }
      // What was already transcribed, and billed, is kept unless most of it was lost.
      const lostSeconds = spans.reduce(
        (total, span, index) => total + (results[index] == null ? span.end - span.start : 0),
        0
      );
      if (lostSeconds / (size / BYTES_PER_SECOND) > CLOUD_CHUNK_MAX_LOSS_RATIO)
        throw stoppedBy ?? firstLoss;
      if (failedChunks > 0)
        return {
          // The saved note would read the segments, which have no mark where audio is missing.
          text: assembleChunkTranscript(results, 0, size / BYTES_PER_SECOND, { spans }),
          warning: `${failedChunks} of ${results.length} chunks failed`,
          failedChunks,
          totalChunks: results.length,
        };
      const text = responses.map((result) => result.text).join(" ");
      return segments ? { text, segments } : { text };
    } finally {
      await pcm.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// An upload can sit out a per-minute rate limit and a slow connection.
const SARVAM_UPLOAD_LIMITS = { maxRetryWaitMs: 60_000, requestTimeoutMs: 60_000 };

module.exports = { transcribeWithSarvam, SARVAM_UPLOAD_LIMITS };
