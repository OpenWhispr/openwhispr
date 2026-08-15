const { net } = require("electron");
const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { convertToWav } = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");

const GEMINI_GENERATE_CONTENT_BASE = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_TRANSCRIPTION_MODEL = "gemini-3-flash-preview";

// generateContent has no dedicated language/prompt form fields, so the
// instruction text carries what Whisper's fields carry: a strict
// transcribe-verbatim directive (or Gemini chats instead of transcribing),
// the target language, and the custom-dictionary spellings.
function buildInstruction({ language, prompt }) {
  const lines = [
    "Transcribe the audio verbatim. Output ONLY the transcript text, with no commentary, labels, or extra formatting. If the audio contains no speech, output nothing.",
  ];
  if (language && language !== "auto") {
    lines.push(`The audio is in the language with ISO 639-1 code "${language}".`);
  }
  if (prompt?.trim()) {
    lines.push(`Prefer these spellings when the corresponding words occur: ${prompt.trim()}`);
  }
  return lines.join("\n");
}

// Gemini's inlineData audio formats do not include webm/Opus (the dictation
// recording format), so every input is converted to 16 kHz mono wav first —
// ffmpeg accepts whatever the dictation or upload paths hand over.
async function transcribeAudio({ audioBuffer, model, language, prompt, apiKey }) {
  if (!apiKey?.trim()) {
    const error = new Error("Gemini API key not configured. Add your key in Settings.");
    error.code = "API_KEY_MISSING";
    throw error;
  }

  const resolvedModel = (model || "").trim() || DEFAULT_GEMINI_TRANSCRIPTION_MODEL;

  const tempDir = fs.mkdtempSync(path.join(getSafeTempDir(), "openwhispr-gemini-"));
  let wavBase64;
  try {
    const inputPath = path.join(tempDir, "input-audio");
    const wavPath = path.join(tempDir, "audio.wav");
    fs.writeFileSync(inputPath, Buffer.from(audioBuffer));
    await convertToWav(inputPath, wavPath, { sampleRate: 16000, channels: 1 });
    wavBase64 = fs.readFileSync(wavPath).toString("base64");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  debugLogger.debug(
    "Gemini transcription starting",
    { model: resolvedModel, language, audioBytes: audioBuffer.byteLength },
    "transcription"
  );

  const response = await net.fetch(
    `${GEMINI_GENERATE_CONTENT_BASE}/models/${resolvedModel}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey.trim() },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildInstruction({ language, prompt }) },
              { inlineData: { mimeType: "audio/wav", data: wavBase64 } },
            ],
          },
        ],
      }),
    }
  );

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
  return { text, model: resolvedModel };
}

module.exports = { transcribeAudio, DEFAULT_GEMINI_TRANSCRIPTION_MODEL };
