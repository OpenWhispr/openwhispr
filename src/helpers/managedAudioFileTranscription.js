const fs = require("node:fs");
const path = require("node:path");
const { getSafeTempDir } = require("./safeTempDir");
const { splitAudioFile, convertToMp3 } = require("./ffmpegUtils");
const { providerContentType, prepareProviderUpload } = require("./providerUploadAudio");
const { CLOUD_CHUNK_MAX_LOSS_RATIO } = require("./cloudChunkPolicy");

// Provider overload and dropped connections are retried; a chunk that still
// fails is skipped and the job keeps the rest. DNS, certificate and proxy
// configuration failures are not here: every chunk would meet them, so they
// abort with the real cause.
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
// Electron's net.fetch (legacy Azure) reports these only in its message.
const RETRYABLE_NET_ERRORS = new Set([
  "net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_CLOSED",
  "net::ERR_CONNECTION_REFUSED",
  "net::ERR_CONNECTION_ABORTED",
  "net::ERR_NETWORK_CHANGED",
  "net::ERR_INTERNET_DISCONNECTED",
  "net::ERR_ADDRESS_UNREACHABLE",
]);
const DEADLINE_NET_ERRORS = new Set(["net::ERR_TIMED_OUT", "net::ERR_CONNECTION_TIMED_OUT"]);
// A deadline already cost a full request timeout, so the chunk is skipped at once.
const DEADLINE_CHUNK_CODES = new Set([
  "TIMEOUT",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
// Every later chunk would meet the same refusal or a context that no longer applies.
const JOB_ABORTING_CODES = new Set([
  "MANAGED_CONFIG_CHANGED",
  "AUTH_CONTEXT_CHANGED",
  "MANAGED_AUTH_REJECTED",
]);

/** "retry", "skip" (count the chunk as failed now), or "abort" (fail the job). */
function chunkFailureAction(error) {
  const codes = [error?.code, error?.cause?.code];
  const netError = String(error?.message ?? "").match(/net::ERR_[A-Z_]+/)?.[0];
  if (codes.some((code) => JOB_ABORTING_CODES.has(code))) return "abort";
  // Callers check the job signal first, so a remaining abort is a request deadline.
  if (
    codes.some((code) => DEADLINE_CHUNK_CODES.has(code)) ||
    DEADLINE_NET_ERRORS.has(netError) ||
    error?.name === "TimeoutError" ||
    error?.name === "AbortError"
  )
    return "skip";
  if (codes.some((code) => RETRYABLE_CHUNK_CODES.has(code)) || RETRYABLE_NET_ERRORS.has(netError))
    return "retry";
  // This chunk's audio was refused or answered badly; the others may still pass.
  if ((error?.status >= 400 && error?.status < 500) || error?.code === "MANAGED_RESPONSE_MALFORMED")
    return "skip";
  // Anything else is a setup failure every later chunk would meet too.
  return "abort";
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
  let lastError;
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
        throw Object.assign(
          new Error("Prepared audio chunk exceeds the enterprise provider limit"),
          {
            code: "MANAGED_CHUNK_TOO_LARGE",
            messageKey: "hooks.audioRecording.errorDescriptions.managedChunkTooLarge",
          }
        );
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
            lastError = error;
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
    // Nothing got through, so the last refusal names the cause better than a loss count.
    if (failed.length === chunkPaths.length) throw lastError;
    // Past the cloud path's loss cap the "transcript" is more hole than content.
    if (failed.length / chunkPaths.length > CLOUD_CHUNK_MAX_LOSS_RATIO || (!text && failed.length))
      throw Object.assign(
        new Error(`${failed.length} of ${chunkPaths.length} audio segments were lost`),
        {
          code: "CHUNK_LOSS_EXCEEDED",
          messageKey: "hooks.audioRecording.errorDescriptions.chunkLoss",
        }
      );
    if (!text)
      throw Object.assign(new Error("No speech detected in audio"), { code: "NO_SPEECH_DETECTED" });
    return { text, failedChunks: failed.length, totalChunks: chunkPaths.length };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { transcribeManagedAudioFile };
