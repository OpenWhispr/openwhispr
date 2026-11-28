const { setTimeout: delay } = require("node:timers/promises");
const { mapVerboseSegments } = require("./uploadTimestamps");
const { formatSpeakerTranscript } = require("./speakerMerge");

// The service returns AWS S3 presigned URLs. Never follow a redirect or
// forward the Gnani API key to storage. Keep signed query strings out of errors.
function storageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("GnaniAI returned an invalid storage URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !/^(?:[a-z0-9.-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/i.test(url.hostname)
  ) {
    throw new Error("GnaniAI returned an unsupported storage URL.");
  }
  return url;
}

function batchTranscript(doc, { model, diarize, jobId, fileId }) {
  if (
    doc?.model !== model ||
    doc.job_id !== jobId ||
    doc.file_id !== fileId ||
    typeof doc.full_transcript !== "string" ||
    !Array.isArray(doc.segments)
  ) {
    throw new Error("GnaniAI returned an invalid Batch transcript.");
  }
  const text = doc.full_transcript.trim();
  const segments = mapVerboseSegments(
    {
      text,
      segments: doc.segments.map((s) => ({
        text: s.text,
        start: s.start_time,
        end: s.end_time,
        ...(diarize && Number.isInteger(s.speaker_id) ? { speaker: String(s.speaker_id) } : {}),
      })),
    },
    { preserveSpeakers: diarize }
  );
  const diarized = diarize && Boolean(segments?.length && segments.every((s) => s.speaker));
  return {
    text: diarized ? formatSpeakerTranscript(segments) : text,
    ...(segments && { segments }),
    diarized,
    ...(diarize && text && !diarized && { diarizationWarning: true }),
    language: doc.language_code,
  };
}

async function transcribeGnaniBatch({
  wav,
  config,
  diarize,
  numSpeakers,
  signal,
  request,
  onProgress,
  apiKey,
  fetchImpl = fetch,
  pollIntervalMs = 10000,
  compactFile,
}) {
  const json = (value) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  const settings = {
    model: config.model,
    language_code: config.languageCode,
    with_diarization: diarize,
    ...(diarize &&
      Number.isInteger(numSpeakers) && { num_speakers: Math.min(8, Math.max(1, numSpeakers)) }),
    ...(config.model === "prisma-v3.0" && { format: config.format }),
    ...(config.keyterms.length && { keyterms: config.keyterms }),
  };
  let jobPath;
  let terminal = false;
  const deadline = AbortSignal.timeout(6 * 60 * 60 * 1000);
  const workSignal = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const storage = (url, options = {}) =>
    fetchImpl(storageUrl(url), {
      ...options,
      redirect: "error",
      signal: AbortSignal.any([workSignal, AbortSignal.timeout(120000)]),
    });
  try {
    let job;
    let audio = wav;
    let name = "recording.wav";
    const createPolicy = { retry: "rate-limit", maxWaitMs: 60000 };
    if (wav.size > 10_000_000) {
      try {
        job = await request(
          "/batch/v2/jobs",
          json({
            config: settings,
            source: { type: "direct_upload_url", files: [{ filename: name }] },
          }),
          createPolicy
        );
      } catch (error) {
        if (error.statusCode !== 404 || !compactFile) throw error;
        audio = await compactFile();
        name = "recording.flac";
        if (audio.size > 10_000_000)
          throw new Error(
            "GnaniAI's large-file endpoint is unavailable and this recording exceeds its 10 MB inline limit after lossless compression."
          );
      }
    }
    const needsTransfer = Boolean(job);
    if (!job) {
      const form = new FormData();
      form.set("config", JSON.stringify(settings));
      form.set("files", audio, name);
      job = await request("/batch/jobs", { method: "POST", body: form }, createPolicy);
    }
    if (typeof job.job_id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(job.job_id))
      throw new Error("GnaniAI did not return a Batch job ID.");
    jobPath = "/batch/jobs/" + job.job_id;
    if (needsTransfer) {
      if (job.uploads?.length !== 1)
        throw new Error("GnaniAI did not provide the requested upload.");
      const transfer = await storage(job.uploads[0].url, { method: "PUT", body: wav });
      if (!transfer.ok) throw new Error("GnaniAI could not receive the Batch audio file.");
    }
    // Retrying start on the same ID cannot create a second transcription job.
    try {
      await request(jobPath + "/start", { method: "POST" }, { retry: true, maxWaitMs: 60000 });
    } catch (error) {
      if (error.statusCode !== 409) throw error;
    }
    for (;;) {
      workSignal.throwIfAborted();
      const status = await request(jobPath, {}, { retry: true, maxWaitMs: 60000 });
      onProgress?.(Math.max(0, Math.min(100, Number(status.progress?.percent) || 0)));
      if (["COMPLETED", "PARTIAL_FAILURE"].includes(status.status)) {
        terminal = true;
        break;
      }
      if (["FAILED", "START_FAILED", "CANCELLED"].includes(status.status)) {
        terminal = true;
        throw new Error(
          "GnaniAI Batch transcription " + status.status.toLowerCase().replace("_", " ") + "."
        );
      }
      if (!["CREATED", "STARTING", "QUEUED", "IN_PROGRESS", "CANCELLING"].includes(status.status))
        throw new Error("GnaniAI returned an unknown Batch job status.");
      await delay(pollIntervalMs, undefined, { signal: workSignal });
    }
    // Each OpenWhispr queue item owns one job/file. A terminal job status alone
    // does not prove that its file succeeded; an expired result URL is renewable.
    for (let attempt = 0; attempt < 2; attempt++) {
      const files = await request(jobPath + "/files", {}, { retry: true, maxWaitMs: 60000 });
      const row = files.data?.[0];
      if (files.data?.length !== 1 || row.status !== "COMPLETED" || !row.transcript_url)
        throw new Error("GnaniAI did not complete this audio file.");
      const result = await storage(row.transcript_url);
      if (attempt === 0 && [401, 403].includes(result.status)) continue;
      if (!result.ok) throw new Error("GnaniAI could not deliver the Batch transcript.");
      const doc = await result.json();
      workSignal.throwIfAborted();
      return batchTranscript(doc, {
        model: config.model,
        diarize,
        jobId: job.job_id,
        fileId: row.file_id,
      });
    }
  } finally {
    if (jobPath && !terminal) {
      // The work signal may already have been cancelled. This request can only
      // stop the existing job and uses its original key with a short deadline.
      const { createGnaniClient } = require("./gnaniTranscription");
      await createGnaniClient({ apiKey, fetchImpl })(
        jobPath + "/cancel",
        json({ reason: "OpenWhispr stopped this upload" }),
        { timeoutMs: 4000 }
      ).catch(() => {});
    }
  }
}

module.exports = { transcribeGnaniBatch };
