const { net } = require("electron");
const debugLogger = require("./debugLogger");

// AssemblyAI's pre-recorded API is a three-step async job, not an
// OpenAI-compatible multipart endpoint: upload the raw audio, submit a
// transcript job against the returned URL, poll the job to completion, then
// read the paragraph-formatted text (the reason to prefer this provider).
// Auth is the raw API key in the `authorization` header — no Bearer prefix.
const ASSEMBLYAI_API_BASE = "https://api.assemblyai.com/v2";
const DEFAULT_BATCH_MODEL = "universal-3-5-pro";
const PARAGRAPH_SEPARATOR = "\n\n";
const REQUEST_TIMEOUT_MS = 30 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

async function requestJson(doFetch, url, init, timeoutMs) {
  let response;
  try {
    response = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err.name === "TimeoutError") {
      throw new Error(`AssemblyAI request timed out: ${new URL(url).pathname}`);
    }
    throw err;
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    let detail = errorText;
    try {
      const parsed = JSON.parse(errorText);
      detail = parsed.error || parsed.detail || errorText;
    } catch {
      detail = errorText;
    }
    if (response.status === 401 || response.status === 403) {
      const error = new Error("Invalid AssemblyAI API key. Check your key in Settings.");
      error.code = "INVALID_KEY";
      throw error;
    }
    const error = new Error(`AssemblyAI API Error: ${response.status} ${detail}`.trim());
    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }
    throw error;
  }
  return response.json();
}

async function uploadAudio(doFetch, apiKey, audioBuffer) {
  const data = await requestJson(
    doFetch,
    `${ASSEMBLYAI_API_BASE}/upload`,
    {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/octet-stream" },
      body: Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer),
    },
    UPLOAD_TIMEOUT_MS
  );
  if (!data?.upload_url) {
    throw new Error("AssemblyAI did not return an upload URL");
  }
  return data.upload_url;
}

// AssemblyAI deprecated the singular `speech_model` request field — the API
// takes a `speech_models` fallback array now. `punctuate`/`format_text`
// default to true, which is what we want, so they're not sent explicitly.
function buildTranscriptRequest(model, language) {
  const body = {
    speech_models: [model || DEFAULT_BATCH_MODEL],
  };
  if (language && language !== "auto") {
    body.language_code = language;
  } else {
    body.language_detection = true;
  }
  return body;
}

async function submitTranscript(doFetch, apiKey, uploadUrl, model, language) {
  const data = await requestJson(
    doFetch,
    `${ASSEMBLYAI_API_BASE}/transcript`,
    {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ audio_url: uploadUrl, ...buildTranscriptRequest(model, language) }),
    },
    REQUEST_TIMEOUT_MS
  );
  if (!data?.id) {
    throw new Error("AssemblyAI did not return a transcript id");
  }
  return data.id;
}

async function pollTranscript(doFetch, apiKey, transcriptId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    const transcript = await requestJson(
      doFetch,
      `${ASSEMBLYAI_API_BASE}/transcript/${transcriptId}`,
      { method: "GET", headers: { authorization: apiKey } },
      REQUEST_TIMEOUT_MS
    );
    if (transcript.status === "completed") {
      return transcript;
    }
    if (transcript.status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error || "unknown error"}`);
    }
  }
  throw new Error("AssemblyAI transcription timed out");
}

async function fetchParagraphText(doFetch, apiKey, transcriptId) {
  try {
    const data = await requestJson(
      doFetch,
      `${ASSEMBLYAI_API_BASE}/transcript/${transcriptId}/paragraphs`,
      { method: "GET", headers: { authorization: apiKey } },
      REQUEST_TIMEOUT_MS
    );
    const text = (data?.paragraphs || [])
      .map((paragraph) => paragraph?.text || "")
      .filter(Boolean)
      .join(PARAGRAPH_SEPARATOR)
      .trim();
    return text || null;
  } catch (err) {
    debugLogger.warn(
      "AssemblyAI paragraphs fetch failed, falling back to transcript text",
      { error: err.message },
      "transcription"
    );
    return null;
  }
}

async function transcribeWithAssemblyAI({ audioBuffer, model, language, apiKey }, fetchImpl) {
  if (!apiKey?.trim()) {
    const error = new Error("AssemblyAI API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  const bytes = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  debugLogger.debug(
    "AssemblyAI batch transcription starting",
    { model: model || DEFAULT_BATCH_MODEL, language, audioBytes: bytes.byteLength },
    "transcription"
  );

  const doFetch = fetchImpl || ((url, init) => net.fetch(url, init));
  const uploadUrl = await uploadAudio(doFetch, apiKey, bytes);
  const transcriptId = await submitTranscript(doFetch, apiKey, uploadUrl, model, language);
  const transcript = await pollTranscript(doFetch, apiKey, transcriptId);
  const text = (await fetchParagraphText(doFetch, apiKey, transcriptId)) || transcript.text || "";
  return { text, model: transcript.speech_model_used || model || DEFAULT_BATCH_MODEL };
}

module.exports = { transcribeWithAssemblyAI };
