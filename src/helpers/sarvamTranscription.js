const { net } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { createAbortError } = require("./abortError");

const SARVAM_TRANSCRIPTION_URL = "https://api.sarvam.ai/speech-to-text";

const SARVAM_DEFAULT_MODEL = "saaras:v3";

// The exact set Sarvam accepts for `language_code`. Anything outside it is a 422,
// so an unmapped language must fall through to auto-detect rather than be guessed
// into a `xx-IN` shape — Sarvam has no Bhojpuri/Rajasthani/etc. code.
const SARVAM_LANGUAGE_CODES = {
  as: "as-IN",
  bn: "bn-IN",
  brx: "brx-IN",
  doi: "doi-IN",
  en: "en-IN",
  gu: "gu-IN",
  hi: "hi-IN",
  kn: "kn-IN",
  kok: "kok-IN",
  ks: "ks-IN",
  mai: "mai-IN",
  ml: "ml-IN",
  mni: "mni-IN",
  mr: "mr-IN",
  ne: "ne-IN",
  od: "od-IN",
  pa: "pa-IN",
  sa: "sa-IN",
  sat: "sat-IN",
  sd: "sd-IN",
  ta: "ta-IN",
  te: "te-IN",
  ur: "ur-IN",
};

const toSarvamLanguageCode = (language) =>
  language && language !== "auto" ? SARVAM_LANGUAGE_CODES[language] : undefined;

// Sarvam's form contract: `file`, `model`, optional `language_code`, and `mode`
// (v3 only). There is no prompt/keyterm field, so the custom dictionary cannot be
// biased here — sending one risks a 422 rather than being ignored.
const sarvamFormFields = (model, language) => {
  const resolved = model || SARVAM_DEFAULT_MODEL;
  const languageCode = toSarvamLanguageCode(language);
  return {
    model: resolved,
    ...(languageCode ? { language_code: languageCode } : {}),
    ...(resolved.startsWith("saaras:v3") ? { mode: "transcribe" } : {}),
  };
};

// Sarvam's synchronous /speech-to-text endpoint accepts at most 30 seconds of
// audio per request; longer recordings need to be segmented client-side (the
// Batch API is the server-side alternative, but it is job-based with
// upload/poll/download round trips, so it trades minutes of latency for
// diarization this path does not need).
const SARVAM_MAX_AUDIO_SECONDS = 30;

// Segment length for anything over the limit. Kept under 30s because the probed
// container duration and ffmpeg's actual segment boundaries need not agree to
// the millisecond, and a segment that lands even slightly over is a hard 400.
// Chosen as high as that margin allows: every boundary can clip a word, so
// fewer, longer segments means fewer seams in the joined transcript.
const SARVAM_SEGMENT_SECONDS = 25;

// Segments are independent HTTP requests, so a long recording is bounded by
// throughput rather than latency. Kept low to stay clear of per-key rate limits.
const SARVAM_SEGMENT_CONCURRENCY = 3;

const SARVAM_SEGMENT_MAX_ATTEMPTS = 3;
const SARVAM_RETRY_BASE_MS = 2_000;
const SARVAM_RETRY_FACTOR = 3;
const SARVAM_RETRY_JITTER_MS = 1_000;

// Credential and quota failures repeat identically on every segment, so they end
// the job instead of being retried once per segment.
const isFatalStatus = (status) => status === 401 || status === 403 || status === 402;
const isTransientStatus = (status) => status === 429 || status >= 500;

// Sarvam reports failures as { error: { message, code, request_id } }, but
// validation errors surface FastAPI's { detail: ... } shape instead. Pull out
// whichever is present so the user sees the API's own diagnosis rather than a
// raw JSON blob — or a guess about the cause.
function extractSarvamErrorDetail(body) {
  if (!body) return "";
  let parsed = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return body.slice(0, 200).trim();
    }
  }
  const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.detail ?? parsed?.message;
  if (typeof candidate === "string") return candidate;
  if (candidate) return JSON.stringify(candidate).slice(0, 200);
  return typeof body === "string" ? body.slice(0, 200).trim() : "";
}

function sarvamErrorMessage(status, body) {
  const detail = extractSarvamErrorDetail(body);
  if (status === 401 || status === 403) {
    return "Invalid Sarvam API key. Check your key in Settings.";
  }
  if (status === 429) {
    return "Sarvam rate limit exceeded. Please try again later.";
  }
  return `Sarvam API Error: ${status}${detail ? ` ${detail}` : ""}`;
}

// The message is plain English like every other provider module, because the
// renderer localizes from `code`/`messageKey` rather than from the text:
// serializeIpcError forwards both, recordingErrors maps them to translated
// titles and descriptions, and TranscriptionItem turns the key-related codes
// into the "fix your key" affordance. An error without a code degrades to raw
// English in all 10 locales and loses that affordance.
function createSarvamError(status, body) {
  const error = Object.assign(new Error(sarvamErrorMessage(status, body)), { status });
  if (status === 401 || status === 403) {
    error.code = "INVALID_KEY";
  } else if (status === 429) {
    error.code = "PROVIDER_RATE_LIMITED";
    error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
  } else if (status >= 500) {
    error.code = "SERVER_ERROR";
  }
  return error;
}

// Segments are cut on a fixed clock, so a boundary can land mid-word and the
// neighbouring transcripts are two halves of one sentence. Joining on a single
// space (and collapsing whatever spacing the model returned at the edges) is the
// closest we get to the unsegmented result without re-punctuating the text.
function joinSarvamTranscripts(parts) {
  return parts
    .filter((part) => typeof part === "string" && part.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Jittered, because segments retry concurrently: without it, three siblings
// that hit the same 429 wait the identical interval and collide again on every
// attempt. Mirrors CLOUD_CHUNK_BACKOFF_JITTER_MS in cloudChunkPolicy.
function retryDelayMs(attempt, random = Math.random) {
  const base = SARVAM_RETRY_BASE_MS * SARVAM_RETRY_FACTOR ** (attempt - 1);
  return base + Math.floor(random() * SARVAM_RETRY_JITTER_MS);
}

// Deliberately not cloudChunkPolicy's abortableSleep, which is otherwise
// identical: that module reaches i18nMain, which pulls i18next and 20 locale
// JSON files in at require time. This runs on the dictation hot path, so it
// keeps the primitive local rather than paying that load cost.
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postSarvamAudio({ apiKey, bytes, fileName, contentType, fields, signal }) {
  const formData = new FormData();
  formData.append("file", new Blob([bytes], { type: contentType }), fileName);
  for (const [field, value] of Object.entries(fields)) {
    formData.append(field, value);
  }

  const response = await net.fetch(SARVAM_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { "api-subscription-key": apiKey },
    body: formData,
    signal,
    // Third-party endpoint — never attach the app session's cookies.
    useSessionCookies: false,
  });

  if (!response.ok) {
    throw createSarvamError(response.status, await response.text().catch(() => ""));
  }

  // Sarvam names the transcript `transcript`; the rest of the app reads `text`.
  const data = await response.json();
  return { ...data, text: data?.transcript || data?.text || "" };
}

// A segment is worth retrying when the failure says nothing about this audio:
// a rate limit, a server fault, or a request that never got an answer. A 4xx
// verdict on the segment itself will be identical next time.
function isRetryableSegmentError(error) {
  if (error?.name === "AbortError") return false;
  if (isFatalStatus(error?.status)) return false;
  return error?.status === undefined || isTransientStatus(error.status);
}

// `waitFor` is a seam: the retry schedule is real time in production and
// nothing at all under test, so covering the loop costs no wall clock.
async function postSegmentWithRetry(index, request, signal, waitFor = sleep) {
  let attempt = 1;
  while (true) {
    if (signal?.aborted) throw createAbortError();
    try {
      return await request();
    } catch (error) {
      if (!isRetryableSegmentError(error) || attempt >= SARVAM_SEGMENT_MAX_ATTEMPTS) throw error;

      debugLogger.warn(`Sarvam segment ${index} attempt ${attempt} failed, retrying`, {
        error: error.message,
        status: error.status,
      });
      await waitFor(retryDelayMs(attempt), signal);
      attempt++;
    }
  }
}

// Runs `worker` over every index with a bounded number in flight, preserving
// input order in the results. The first failure stops the runners from picking
// up further work — a partial transcript that reads as complete is worse than a
// visible failure — and is rethrown once every runner has settled.
//
// Latching the failure rather than letting Promise.all reject on it is what
// makes the caller's cleanup safe: an early reject would delete the segment
// directory while sibling runners were still reading files out of it, turning
// their ENOENT into silence on POSIX and an EPERM that masks the real error on
// Windows.
async function mapWithConcurrency(count, limit, worker) {
  const results = new Array(count);
  let next = 0;
  let failure = null;

  const run = async () => {
    while (failure === null) {
      const index = next++;
      if (index >= count) return;
      try {
        results[index] = await worker(index);
      } catch (error) {
        failure ??= error;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, count) }, run));
  if (failure) throw failure;
  return results;
}

/**
 * Transcribes audio of any length through Sarvam's synchronous REST endpoint.
 *
 * Audio within the endpoint's 30-second limit is forwarded byte-for-byte. Longer
 * audio is segmented with FFmpeg and the segment transcripts are joined in
 * order. A duration that cannot be probed is treated as short and sent
 * unmodified, so a missing or failed FFmpeg degrades to the previous behaviour
 * rather than blocking transcription.
 *
 * @returns {Promise<{ text: string, model: string, segmentCount: number, durationSeconds: number|null }>}
 */
async function transcribeWithSarvam({
  apiKey,
  audioBuffer,
  fileName = "audio.webm",
  contentType = "audio/webm",
  model,
  language,
  signal,
  onProgress,
}) {
  if (!apiKey?.trim()) {
    const error = new Error("Sarvam API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  const fields = sarvamFormFields(model, language);
  const buffer = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  const { probeAudioDuration, splitAudioFile } = require("./ffmpegUtils");

  const jobId = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const workDir = path.join(os.tmpdir(), `ow-sarvam-${jobId}`);
  let durationSeconds = null;

  try {
    fs.mkdirSync(workDir, { recursive: true });
    const inputPath = path.join(workDir, `input${path.extname(fileName) || ".webm"}`);
    fs.writeFileSync(inputPath, buffer);

    durationSeconds = await probeAudioDuration(inputPath, { signal });

    if (!(durationSeconds > SARVAM_MAX_AUDIO_SECONDS)) {
      debugLogger.debug(
        "Sarvam transcription starting",
        { audioBytes: buffer.byteLength, durationSeconds, model: fields.model, language },
        "transcription"
      );
      const data = await postSarvamAudio({
        apiKey,
        bytes: buffer,
        fileName,
        contentType,
        fields,
        signal,
      });
      return { ...data, model: fields.model, segmentCount: 1, durationSeconds };
    }

    const { chunkPaths } = await splitAudioFile(inputPath, workDir, {
      segmentDuration: SARVAM_SEGMENT_SECONDS,
      signal,
    });

    debugLogger.debug(
      "Sarvam transcription segmenting long audio",
      {
        audioBytes: buffer.byteLength,
        durationSeconds,
        segmentCount: chunkPaths.length,
        segmentSeconds: SARVAM_SEGMENT_SECONDS,
        model: fields.model,
        language,
      },
      "transcription"
    );

    // splitAudioFile always writes 16 kHz mono MP3 — Sarvam's documented
    // preferred input — so the segment name and type are fixed here.
    const jobController = new AbortController();
    const abortJob = () => jobController.abort();
    signal?.addEventListener("abort", abortJob, { once: true });
    if (signal?.aborted) abortJob();

    let completed = 0;
    try {
      const transcripts = await mapWithConcurrency(
        chunkPaths.length,
        SARVAM_SEGMENT_CONCURRENCY,
        async (index) => {
          const data = await postSegmentWithRetry(
            index,
            () =>
              postSarvamAudio({
                apiKey,
                bytes: fs.readFileSync(chunkPaths[index]),
                fileName: path.basename(chunkPaths[index]),
                contentType: "audio/mpeg",
                fields,
                signal: jobController.signal,
              }),
            jobController.signal
          );
          completed++;
          onProgress?.({ segmentsTotal: chunkPaths.length, segmentsCompleted: completed });
          return data.text;
        }
      );

      return {
        text: joinSarvamTranscripts(transcripts),
        model: fields.model,
        segmentCount: chunkPaths.length,
        durationSeconds,
      };
    } catch (error) {
      // Stop the segments still on the wire before unwinding, or they keep
      // burning quota for a transcript nobody will read.
      abortJob();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abortJob);
    }
  } finally {
    // Guarded: an unguarded throw here would replace the Sarvam error the user
    // actually needs to see with a filesystem error about our own scratch dir.
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch (cleanupError) {
      debugLogger.warn("Failed to clean up Sarvam segment directory", {
        error: cleanupError.message,
      });
    }
  }
}

module.exports = {
  SARVAM_TRANSCRIPTION_URL,
  SARVAM_DEFAULT_MODEL,
  SARVAM_LANGUAGE_CODES,
  SARVAM_MAX_AUDIO_SECONDS,
  SARVAM_SEGMENT_SECONDS,
  SARVAM_SEGMENT_CONCURRENCY,
  SARVAM_SEGMENT_MAX_ATTEMPTS,
  toSarvamLanguageCode,
  sarvamFormFields,
  sarvamErrorMessage,
  extractSarvamErrorDetail,
  joinSarvamTranscripts,
  isRetryableSegmentError,
  postSegmentWithRetry,
  retryDelayMs,
  transcribeWithSarvam,
};
