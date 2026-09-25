const fs = require("fs");
const path = require("path");
const { getSafeTempDir } = require("./safeTempDir");
const {
  CLOUD_UPLOAD_TIMEOUT_MS,
  CLOUD_CHUNK_MAX_ATTEMPTS,
  CLOUD_CHUNK_MAX_LOSS_RATIO,
  SILENT_CHUNK,
  summarizeChunkResults,
  assembleChunkTranscript,
  chunkRetryDelayMs,
  abortableSleep,
} = require("./cloudChunkPolicy");

// Audio Upload through OpenRouter (#2105). Its upstream providers stop after
// about 60 s of work per request and its multipart bodies stop at 25 MB, so a
// recording goes out as 4-minute MP3 pieces, one at a time: ~8 s of work each at
// the slowest benchmarked model (~30x real time), ~3.8 MB each. The retry budget,
// timeout, loss ceiling and transcript assembly are the Cloud upload's
// (cloudChunkPolicy), so both read alike. Kept free of electron imports so the
// rules stay unit-testable.
const OPENROUTER_CHUNK_SECONDS = 240;

// ffmpeg can leave a sliver of a last piece (hundredths of a second when the
// length is an exact multiple). Providers reject audio that short, so it is
// dropped rather than sent and reported as lost audio. Judged by the piece's
// own size (the splitter's 128 kbps MP3 is ~16 KB a second): the input's
// duration is only an estimate for some files, such as a VBR MP3 without a
// header or raw AAC, and a short estimate would drop a real last piece.
const MIN_LAST_PIECE_BYTES = 8_000;

// The account or the model is at fault, so every remaining piece would fail the
// same way: bad key, out of credits, spend limit or disabled key, unknown model.
const STOP_STATUSES = new Set([401, 402, 403, 404]);

// No answer at all (network, timeout), rate limiting and server-side failures
// can clear on their own; any other rejection is about this request.
function isRetryable(err) {
  const status = err.statusCode;
  return !status || status === 408 || status === 429 || status >= 500;
}

// Pieces go one at a time, so one that is still rate limited, or still gets no
// answer, after its retries stops the upload too: the next would sit through
// the same. What was already transcribed, and billed, is kept.
function stopsUpload(err) {
  return !err.statusCode || err.statusCode === 429 || STOP_STATUSES.has(err.statusCode);
}

async function transcribeOpenRouterChunks({
  inputPath,
  split,
  transcribeChunk,
  onProgress,
  signal,
  segmentSeconds = OPENROUTER_CHUNK_SECONDS,
  retryDelayMs = chunkRetryDelayMs,
  attemptTimeoutMs = CLOUD_UPLOAD_TIMEOUT_MS,
}) {
  // ffmpeg writes the pieces here; Windows temp paths with spaces or non-ASCII
  // characters break it, which getSafeTempDir avoids.
  const chunkDir = fs.mkdtempSync(path.join(getSafeTempDir(), "ow-openrouter-chunks-"));
  try {
    onProgress?.({ stage: "splitting", chunksTotal: 0, chunksCompleted: 0 });
    const { chunkPaths, durationSeconds } = await split(inputPath, chunkDir, {
      segmentDuration: segmentSeconds,
      audioOnly: true,
      signal,
    });
    const pieces =
      chunkPaths.length > 1 && fs.statSync(chunkPaths.at(-1)).size < MIN_LAST_PIECE_BYTES
        ? chunkPaths.slice(0, -1)
        : chunkPaths;
    const totalChunks = pieces.length;
    // A length estimate shorter than the pieces themselves is wrong; left in, it
    // would end a missing-audio marker before it starts.
    const knownDuration =
      durationSeconds > (totalChunks - 1) * segmentSeconds ? durationSeconds : null;
    onProgress?.({ stage: "transcribing", chunksTotal: totalChunks, chunksCompleted: 0 });

    const transcribeWithRetries = async (piece) => {
      for (let attempt = 1; ; attempt++) {
        const timeout = AbortSignal.timeout(attemptTimeoutMs);
        try {
          return await transcribeChunk(
            piece,
            signal ? AbortSignal.any([signal, timeout]) : timeout
          );
        } catch (err) {
          if (signal?.aborted || !isRetryable(err) || attempt >= CLOUD_CHUNK_MAX_ATTEMPTS)
            throw err;
          await abortableSleep(retryDelayMs(attempt), signal);
        }
      }
    };

    const results = new Array(totalChunks).fill(null);
    let firstLoss = null;
    let stoppedBy = null;
    for (let index = 0; index < totalChunks; index++) {
      try {
        const { text } = await transcribeWithRetries(pieces[index]);
        results[index] = text?.trim() ? { text } : SILENT_CHUNK;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (stopsUpload(err)) {
          stoppedBy = err;
          break;
        }
        firstLoss ??= err;
      }
      onProgress?.({ stage: "transcribing", chunksTotal: totalChunks, chunksCompleted: index + 1 });
    }

    // Pieces never sent after a stop count as lost. The stop's own error says
    // why (out of credits, bad key, no answer), so it wins whenever too little
    // was transcribed to keep.
    const { responses, failedChunks, silentChunks } = summarizeChunkResults(results);
    if (responses.length === 0) {
      if (stoppedBy) throw stoppedBy;
      if (silentChunks === totalChunks) {
        throw Object.assign(new Error("No speech detected in audio"), {
          code: "NO_SPEECH_DETECTED",
        });
      }
      throw firstLoss;
    }
    if (failedChunks / totalChunks > CLOUD_CHUNK_MAX_LOSS_RATIO) {
      if (stoppedBy) throw stoppedBy;
      throw Object.assign(new Error(`${failedChunks} of ${totalChunks} audio segments were lost`), {
        code: "CHUNK_LOSS_EXCEEDED",
      });
    }
    return {
      text: assembleChunkTranscript(results, segmentSeconds, knownDuration),
      ...(failedChunks > 0
        ? { warning: `${failedChunks} of ${totalChunks} chunks failed`, failedChunks, totalChunks }
        : {}),
    };
  } finally {
    // Best effort: cancelling mid-split on Windows can leave ffmpeg holding a
    // piece open, and that must not replace the job's own result or error.
    try {
      fs.rmSync(chunkDir, { recursive: true, force: true });
    } catch {
      // The pieces stay in the temp folder.
    }
  }
}

module.exports = { OPENROUTER_CHUNK_SECONDS, transcribeOpenRouterChunks };
