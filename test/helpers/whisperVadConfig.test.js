import { it, expect } from "vitest";
import { DEFAULT_WHISPER_VAD_CONFIG, sanitizeWhisperVadConfig, resolveContextSileroEnabled } from "../../src/helpers/whisperVadConfig.js";

it("sanitizeWhisperVadConfig applies defaults and clamps invalid values", () => {
  const cfg = sanitizeWhisperVadConfig({
    threshold: 99,
    minSpeechDurationMs: -20,
    minSilenceDurationMs: "bad",
    maxSpeechDurationS: 0,
    speechPadMs: null,
    samplesOverlap: -1,
  });

  expect(cfg).toEqual({
    threshold: 0.95,
    minSpeechDurationMs: 50,
    minSilenceDurationMs: DEFAULT_WHISPER_VAD_CONFIG.minSilenceDurationMs,
    maxSpeechDurationS: 5,
    speechPadMs: DEFAULT_WHISPER_VAD_CONFIG.speechPadMs,
    samplesOverlap: 0,
  });
});

it("resolveContextSileroEnabled prefers context value then falls back to true", () => {
  expect(resolveContextSileroEnabled({ dictationSileroEnabled: false }, "dictation")).toBe(false);
  expect(resolveContextSileroEnabled({ noteRecordingSileroEnabled: true }, "noteRecording")).toBe(true);
  expect(resolveContextSileroEnabled({}, "meeting")).toBe(true);
});
