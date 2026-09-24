const test = require("node:test");
const assert = require("node:assert/strict");

const { listLocalTranscriptionModels } = require("../../src/helpers/localTranscriptionModels.js");
const registry = require("../../src/models/modelRegistryData.json");

const managers = (downloaded) => ({
  whisperManager: { isModelDownloaded: (m) => downloaded.has(m) },
  parakeetManager: { isModelDownloaded: (m) => downloaded.has(m) },
});

test("lists every registry model with provider, download state, and the app's default", () => {
  const models = listLocalTranscriptionModels({
    ...managers(new Set(["base", "cohere-transcribe-03-2026"])),
    env: { LOCAL_TRANSCRIPTION_PROVIDER: "whisper", LOCAL_WHISPER_MODEL: "base" },
  });

  const whisperCount = Object.keys(registry.whisperModels).length;
  const sherpaCount = Object.keys(registry.parakeetModels).length;
  assert.equal(models.length, whisperCount + sherpaCount);

  const base = models.find((m) => m.model === "base");
  assert.deepEqual(base, { provider: "whisper", model: "base", downloaded: true, default: true });

  const cohere = models.find((m) => m.model === "cohere-transcribe-03-2026");
  assert.equal(cohere.provider, "cohere");
  assert.equal(cohere.downloaded, true);
  assert.equal(cohere.default, false);

  assert.equal(models.filter((m) => m.default).length, 1);
  assert.ok(models.some((m) => m.provider === "nvidia"));
});

test("a sherpa default is read from PARAKEET_MODEL, and cloud mode yields no default", () => {
  const withParakeet = listLocalTranscriptionModels({
    ...managers(new Set()),
    env: { LOCAL_TRANSCRIPTION_PROVIDER: "nvidia", PARAKEET_MODEL: "parakeet-tdt-0.6b-v3" },
  });
  assert.deepEqual(
    withParakeet.filter((m) => m.default).map((m) => m.model),
    ["parakeet-tdt-0.6b-v3"]
  );

  const cloudMode = listLocalTranscriptionModels({ ...managers(new Set()), env: {} });
  assert.equal(
    cloudMode.some((m) => m.default),
    false
  );
});
