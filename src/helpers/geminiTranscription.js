const { net } = require("electron");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { convertToWav } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");

const GEMINI_GENERATE_CONTENT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_TRANSCRIPTION_MODEL = "gemini-3-flash-preview";

// When a model is overloaded (503 twice in a row), one attempt on a sibling
// model with its own capacity pool rescues the dictation.
const FALLBACK_503_MODELS = {
  "gemini-3-flash-preview": "gemini-3.5-flash-lite",
  "gemini-3.5-flash-lite": "gemini-3-flash-preview",
};

// generateContent has no dedicated language/prompt form fields, so the
// instruction text carries what Whisper's fields carry: a strict
// transcribe-verbatim directive (or Gemini chats instead of transcribing),
// the target language, and the custom-dictionary spellings.
//
// When a cleanupPrompt is provided (dictation with Gemini cleanup), the call
// is fused: the cleanup rules lead, a bridging directive maps "the transcript"
// onto the attached audio, and the result is the already-cleaned text. The
// cleanup prompt carries the custom-dictionary suffix itself, so the separate
// spellings line is skipped to avoid stating the dictionary twice.
function buildInstruction({ language, prompt, cleanupPrompt }) {
  const cleanup = cleanupPrompt?.trim();
  const lines = cleanup
    ? [
        cleanup,
        "The transcript to clean arrives as the attached audio: transcribe it accurately, then apply the rules above. Output ONLY the cleaned transcript text, no commentary. If the audio contains no speech, output nothing.",
      ]
    : [
        "Transcribe the audio verbatim. Output ONLY the transcript text, with no commentary, labels, or extra formatting. If the audio contains no speech, output nothing.",
      ];
  if (language && language !== "auto") {
    lines.push(`The audio is in the language with ISO 639-1 code "${language}".`);
  }
  if (!cleanup && prompt?.trim()) {
    lines.push(`Prefer these spellings when the corresponding words occur: ${prompt.trim()}`);
  }
  return lines.join("\n");
}

// Transcription needs no reasoning, and default thinking adds seconds of
// latency per dictation. 3.x models take thinkingLevel; 2.5 models take
// thinkingBudget. Unknown models get no config, and a 400 retries without it.
function thinkingConfigFor(model) {
  if (model.startsWith("gemini-3")) return { thinkingLevel: "minimal" };
  if (model.startsWith("gemini-2.5")) return { thinkingBudget: 0 };
  return null;
}

// Gemini's inlineData audio formats do not include webm/Opus (the dictation
// recording format), so every input is converted to 16 kHz mono wav first —
// ffmpeg accepts whatever the dictation or upload paths hand over.
async function transcribeAudio({ audioBuffer, model, language, prompt, cleanupPrompt, apiKey }) {
  if (!apiKey?.trim()) {
    const error = new Error("Gemini API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  const resolvedModel = (model || "").trim() || DEFAULT_GEMINI_TRANSCRIPTION_MODEL;

  const tempDir = fs.mkdtempSync(path.join(getSafeTempDir(), "openwhispr-gemini-"));
  let audioBase64;
  try {
    const inputPath = path.join(tempDir, "input-audio");
    // Opus at 24 kbps mono keeps speech fully intelligible at roughly 1/15
    // the size of pcm wav — smaller uploads finish faster and are far less
    // likely to be load-shed (503) on long dictations.
    const oggPath = path.join(tempDir, "audio.ogg");
    fs.writeFileSync(inputPath, Buffer.from(audioBuffer));
    await convertToWav(inputPath, oggPath, {
      sampleRate: 16000,
      channels: 1,
      codec: "libopus",
      bitrate: "24k",
    });
    audioBase64 = fs.readFileSync(oggPath).toString("base64");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  debugLogger.debug(
    "Gemini transcription starting",
    { model: resolvedModel, language, audioBytes: audioBuffer.byteLength },
    "transcription"
  );

  const instruction = buildInstruction({ language, prompt, cleanupPrompt });
  const attempt = async (targetModel) => {
    const thinking = thinkingConfigFor(targetModel);
    const doFetch = (withThinking) =>
      net.fetch(`${GEMINI_GENERATE_CONTENT_BASE}/models/${targetModel}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: instruction },
                { inlineData: { mimeType: "audio/ogg", data: audioBase64 } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            ...(withThinking && thinking ? { thinkingConfig: thinking } : {}),
          },
        }),
      });
    let response = await doFetch(true);
    if (response.status === 400 && thinking) {
      // The thinking knob varies across model generations — retry without it
      // rather than failing the dictation on an INVALID_ARGUMENT.
      debugLogger.debug(
        "Gemini rejected thinkingConfig, retrying without it",
        { model: targetModel },
        "transcription"
      );
      response = await doFetch(false);
    }
    return response;
  };

  let usedModel = resolvedModel;
  let response = await attempt(usedModel);
  if (response.status === 503) {
    // Transient "model overloaded" spikes — one short-backoff retry so a
    // long dictation isn't lost to a momentary capacity blip.
    debugLogger.debug(
      "Gemini returned 503, retrying once after backoff",
      { model: usedModel },
      "transcription"
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    response = await attempt(usedModel);
  }
  if (response.status === 503) {
    // Still overloaded: each model has its own capacity pool, so one
    // different-model attempt beats failing the dictation outright.
    const fallback = FALLBACK_503_MODELS[usedModel] || DEFAULT_GEMINI_TRANSCRIPTION_MODEL;
    debugLogger.debug(
      "Gemini still overloaded, trying fallback model",
      { from: usedModel, to: fallback },
      "transcription"
    );
    usedModel = fallback;
    response = await attempt(usedModel);
  }

  if (response.status === 401 || response.status === 403) {
    const error = new Error("Invalid Gemini API key. Check your key in Settings.");
    error.code = "INVALID_KEY";
    throw error;
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(`Gemini API Error: ${response.status} ${errorText}`.trim());
    if (response.status === 429) {
      error.code = "PROVIDER_RATE_LIMITED";
      error.messageKey = "hooks.audioRecording.errorDescriptions.providerRateLimited";
    } else if (response.status >= 500) {
      error.code = "SERVER_ERROR";
    }
    throw error;
  }

  const data = await response.json();
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || "")
    .join("")
    .trim();
  return { text, model: usedModel, alreadyCleaned: !!cleanupPrompt?.trim() };
}

module.exports = { transcribeAudio, DEFAULT_GEMINI_TRANSCRIPTION_MODEL };
