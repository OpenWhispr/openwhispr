import { it, expect } from "vitest";
import WhisperServerManager from "../../src/helpers/whisperServer";

it("buildWhisperServerArgs includes VAD flags when enabled and model path provided", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    vadEnabled: true,
    vadModelPath: "/tmp/ggml-silero-v5.1.2.bin",
    vadConfig: {
      threshold: 0.3,
      minSpeechDurationMs: 180,
      minSilenceDurationMs: 250,
      maxSpeechDurationS: 24,
      speechPadMs: 120,
      samplesOverlap: 0.42,
    },
  });

  expect(args).toEqual([
    "--model",
    "/tmp/model.bin",
    "--host",
    "127.0.0.1",
    "--port",
    "8180",
    "--language",
    "auto",
    "--vad",
    "--vad-model",
    "/tmp/ggml-silero-v5.1.2.bin",
    "--vad-threshold",
    "0.3",
    "--vad-min-speech-duration-ms",
    "180",
    "--vad-min-silence-duration-ms",
    "250",
    "--vad-max-speech-duration-s",
    "24",
    "--vad-speech-pad-ms",
    "120",
    "--vad-samples-overlap",
    "0.42",
  ]);
});

it("buildWhisperServerArgs omits VAD flags when vadModelPath is missing", () => {
  const args = WhisperServerManager.buildWhisperServerArgs({
    modelPath: "/tmp/model.bin",
    port: 8180,
    language: "auto",
    vadEnabled: true,
    vadModelPath: null,
  });

  expect(args.includes("--vad")).toBe(false);
  expect(args.includes("--vad-model")).toBe(false);
});

it("getVadSignature changes when VAD settings or model path change", () => {
  const a = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadModelPath: "/m.bin",
    vadConfig: { threshold: 0.5 },
  });
  const b = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadModelPath: "/m.bin",
    vadConfig: { threshold: 0.6 },
  });
  const c = WhisperServerManager.getVadSignature({
    vadEnabled: false,
    vadModelPath: "/m.bin",
    vadConfig: { threshold: 0.6 },
  });
  const d = WhisperServerManager.getVadSignature({
    vadEnabled: true,
    vadModelPath: null,
    vadConfig: { threshold: 0.5 },
  });

  expect(a).not.toBe(b);
  expect(b).not.toBe(c);
  expect(c).toBe(d);
});
