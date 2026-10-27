const fs = require("node:fs");
const path = require("node:path");
const { getSafeTempDir } = require("./safeTempDir");
const { splitAudioFile, convertToMp3 } = require("./ffmpegUtils");
const { providerContentType, prepareProviderUpload } = require("./providerUploadAudio");

// Provider overload and fast network failures from the enterprise transport
// are retried; a chunk that still fails is skipped and the job keeps the rest.
const RETRYABLE_CHUNK_CODES = new Set([
  "PROVIDER_RATE_LIMITED",
  "SERVER_ERROR",
  "PROXY_FAILED",
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
]);
// A deadline already cost a full request timeout, so the chunk is skipped at once.
const DEADLINE_CHUNK_CODES = new Set([
  "TIMEOUT",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const JOB_RETIRING_CODES = new Set(["MANAGED_CONFIG_CHANGED", "AUTH_CONTEXT_CHANGED"]);

/** "retry", "skip" (count the chunk as failed now), or "abort" (fail the job). */
function chunkFailureAction(error) {
  const codes = [error?.code, error?.cause?.code];
  if (codes.some((code) => JOB_RETIRING_CODES.has(code))) return "abort";
  // Callers check the job signal first, so a remaining abort is a request deadline.
  if (
    codes.some((code) => DEADLINE_CHUNK_CODES.has(code)) ||
    error?.name === "TimeoutError" ||
    error?.name === "AbortError"
  )
    return "skip";
  return codes.some((code) => RETRYABLE_CHUNK_CODES.has(code)) ? "retry" : "abort";
}

async function transcribeSingleRequest(transcribe, onProgress, audioBuffer, fileName, contentType) {
  onProgress?.({ stage: "transcribing", chunksTotal: 1, chunksCompleted: 0 });
  const text = await transcribe(audioBuffer, fileName, contentType);
  onProgress?.({ stage: "transcribing", chunksTotal: 1, chunksCompleted: 1 });
  return { text };
}

async function transcribeManagedAudioFile({
  filePath,
  audioBuffer,
  fileName = "audio.webm",
  contentType = "audio/webm",
  maxUploadBytes,
  transcribe,
  signal,
  onProgress,
}) {
  signal?.throwIfAborted();
  if (audioBuffer) {
    if (audioBuffer.length <= maxUploadBytes)
      return transcribeSingleRequest(transcribe, onProgress, audioBuffer, fileName, contentType);
    const temporary = fs.mkdtempSync(path.join(getSafeTempDir(), "enterprise-buffer-"));
    try {
      const source = path.join(temporary, path.basename(fileName));
      fs.writeFileSync(source, audioBuffer, { mode: 0o600 });
      return await transcribeManagedAudioFile({
        filePath: source,
        maxUploadBytes,
        transcribe,
        signal,
        onProgress,
      });
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  const upload = await prepareProviderUpload(filePath, { signal });
  if (upload.path !== filePath) {
    try {
      return await transcribeManagedAudioFile({
        filePath: upload.path,
        maxUploadBytes,
        transcribe,
        signal,
        onProgress,
      });
    } finally {
      upload.cleanup();
    }
  }
  if (fs.statSync(filePath).size <= maxUploadBytes)
    return transcribeSingleRequest(
      transcribe,
      onProgress,
      fs.readFileSync(filePath),
      path.basename(filePath),
      providerContentType(filePath)
    );
  const directory = fs.mkdtempSync(path.join(getSafeTempDir(), "enterprise-chunks-"));
  const texts = [];
  const failed = [];
  try {
    onProgress?.({ stage: "splitting", chunksTotal: 0, chunksCompleted: 0 });
    // At 128 kbit/s, leave room for MP3/container overhead and encoder padding.
    const segmentDuration = Math.max(
      1,
      Math.min(600, Math.floor((maxUploadBytes - 65536) / 16000))
    );
    const { chunkPaths, durationSeconds } = await splitAudioFile(filePath, directory, {
      segmentDuration,
      signal,
    });
    const tailDuration =
      durationSeconds === null ? null : durationSeconds - (chunkPaths.length - 1) * segmentDuration;
    // Encoder padding can create a trailing clip Azure cannot decode. Keep any
    // final speech and pad it with silence instead of dropping the short tail.
    if (tailDuration === null || tailDuration < 1) {
      const paddedTail = path.join(directory, "final-chunk.mp3");
      await convertToMp3(chunkPaths.at(-1), paddedTail, {
        audioBitrate: "128k",
        minimumDurationSeconds: 1,
        signal,
      });
      chunkPaths[chunkPaths.length - 1] = paddedTail;
    }
    for (const [index, chunkPath] of chunkPaths.entries()) {
      signal?.throwIfAborted();
      onProgress?.({
        stage: "transcribing",
        chunksTotal: chunkPaths.length,
        chunksCompleted: index,
      });
      if (fs.statSync(chunkPath).size > maxUploadBytes)
        throw new Error("Prepared audio chunk exceeds the enterprise provider limit");
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          texts[index] = await transcribe(
            fs.readFileSync(chunkPath),
            path.basename(chunkPath),
            "audio/mpeg"
          );
          break;
        } catch (error) {
          signal?.throwIfAborted();
          if (error.code === "NO_SPEECH_DETECTED") {
            texts[index] = "";
            break;
          }
          const action = chunkFailureAction(error);
          if (action === "abort") throw error;
          if (action === "skip" || attempt === 2) {
            failed.push(index);
            break;
          }
          await require("node:timers/promises").setTimeout(500 * 2 ** attempt, undefined, {
            signal,
          });
        }
      }
    }
    onProgress?.({
      stage: "transcribing",
      chunksTotal: chunkPaths.length,
      chunksCompleted: chunkPaths.length,
    });
    const text = texts.filter(Boolean).join(" ");
    if (!text)
      throw Object.assign(new Error("No usable enterprise transcript was returned"), {
        code: failed.length ? "SERVER_ERROR" : "NO_SPEECH_DETECTED",
      });
    return { text, failedChunks: failed.length, totalChunks: chunkPaths.length };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { transcribeManagedAudioFile };
