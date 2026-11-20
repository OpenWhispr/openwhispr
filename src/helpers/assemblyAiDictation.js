const debugLogger = require("./debugLogger");
const {
  PROVIDER_ERROR_CODES,
  providerHttpError,
  providerError,
  redactProviderBody,
} = require("./providerHttpErrors");

const ASSEMBLYAI_DICTATION_URL = "https://dictation.assemblyai.com/v1/transcribe";

// AssemblyAI asks clients to wait 90 s; the request has no deadline of its own.
const REQUEST_TIMEOUT_MS = 90_000;

// AssemblyAI's Dictation API transcribes a finished recording and rewrites it in
// the same request. `text` is the verbatim transcript and `llm_response` the
// rewrite, which is null (with `llm_error`) when only the rewrite failed.
async function transcribeWithAssemblyAiDictation(
  { audioBuffer, contentType, language, keyterms, apiKey, signal },
  fetchImpl
) {
  if (!apiKey?.trim()) {
    throw providerError(PROVIDER_ERROR_CODES.KEY_MISSING, {
      provider: "AssemblyAI",
      surface: "transcription",
    });
  }

  const config = {};
  // The API answers 400 to a language code outside its list.
  const { ASSEMBLYAI_DICTATION_LANGUAGES } = await import("./transcriptionRoute.ts");
  if (language && ASSEMBLYAI_DICTATION_LANGUAGES.has(language)) {
    config.language_codes = [language];
  }
  if (keyterms && keyterms.length > 0) {
    config.keyterms_prompt = keyterms;
  }

  const audioType = (contentType || "audio/webm").split(";")[0].trim();
  const formData = new FormData();
  formData.append("config", new Blob([JSON.stringify(config)], { type: "application/json" }));
  formData.append(
    "audio",
    new Blob([Buffer.from(audioBuffer)], { type: audioType }),
    `audio.${audioType.split("/")[1] || "webm"}`
  );

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    signal?.throwIfAborted();
    response = await fetchImpl(ASSEMBLYAI_DICTATION_URL, {
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      method: "POST",
      // The API key goes in raw, with no Bearer prefix.
      headers: { Authorization: apiKey },
      body: formData,
    });
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) {
      throw providerError(PROVIDER_ERROR_CODES.TIMEOUT, {
        provider: "AssemblyAI",
        surface: "transcription",
      });
    }
    throw error;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    debugLogger.warn("AssemblyAI dictation failed", {
      status: response.status,
      body: redactProviderBody(errorText),
    });
    throw providerHttpError({
      provider: "AssemblyAI",
      status: response.status,
      body: errorText,
      headers: response.headers,
      surface: "transcription",
    });
  }

  const result = await response.json();
  if (result?.llm_error) {
    // Still a 200: the caller falls back to the app's own cleanup of `text`.
    debugLogger.warn("AssemblyAI dictation returned no rewrite", {
      error: redactProviderBody(result.llm_error),
    });
  }
  return {
    text: result?.text,
    cleanedText: typeof result?.llm_response === "string" ? result.llm_response : undefined,
  };
}

// Live dictation and History supply recorded bytes; chat and agent supply a
// validated temp file. Only a recording that needs splitting goes through FFmpeg.
async function transcribeAssemblyAiRecording(
  { audioBuffer, filePath, contentType, durationSeconds, split, ...options },
  fetchImpl
) {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const { getSafeTempDir } = require("./safeTempDir");
  const { byokFileSizeLimit } = await import("./transcriptionRoute.ts");
  const { signal } = options;
  signal.throwIfAborted();
  const transcribe = (bytes, type) =>
    transcribeWithAssemblyAiDictation(
      { ...options, audioBuffer: bytes, contentType: type },
      fetchImpl
    );
  const size = filePath ? (await fs.stat(filePath)).size : audioBuffer.byteLength;
  const overDurationLimit = durationSeconds >= 20 * 60;
  if (!overDurationLimit && size <= byokFileSizeLimit("assemblyai")) {
    try {
      const bytes = audioBuffer ?? (await fs.readFile(filePath, { signal }));
      return await transcribe(bytes, contentType);
    } catch (error) {
      // Older History rows can lack a duration, and a capture clock is only an estimate.
      if (error.status !== 413) throw error;
    }
  }

  signal.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(getSafeTempDir(), "ow-assemblyai-"));
  try {
    const input = filePath ?? path.join(directory, "recording");
    if (!filePath) {
      const bytes = ArrayBuffer.isView(audioBuffer) ? audioBuffer : new Uint8Array(audioBuffer);
      await fs.writeFile(input, bytes, { signal });
    }
    const splitAt = (seconds, output) =>
      split(input, output, { segmentDuration: seconds, audioOnly: true, signal });
    const segmentSeconds = 600;
    let { chunkPaths } = await splitAt(segmentSeconds, directory);
    // At an exact cut FFmpeg can leave a final MP3 too short to decode. At
    // 128 kbps, 8 KB is half a second. Move the last cut a minute earlier
    // across the preceding pieces so the final audio stays in the transcript.
    if (chunkPaths.length > 1 && (await fs.stat(chunkPaths.at(-1))).size < 8_000) {
      const output = path.join(directory, "recut");
      await fs.mkdir(output);
      const seconds = segmentSeconds - 60 / (chunkPaths.length - 1);
      ({ chunkPaths } = await splitAt(seconds, output));
    }
    const parts = [];
    for (const chunkPath of chunkPaths) {
      signal.throwIfAborted();
      const { text } = await transcribe(await fs.readFile(chunkPath, { signal }), "audio/mpeg");
      if (text?.trim()) parts.push(text.trim());
    }
    // Cleanup, translation, and snippet matching need the complete utterance.
    return { text: parts.join(" ") };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

module.exports = { transcribeWithAssemblyAiDictation, transcribeAssemblyAiRecording };
