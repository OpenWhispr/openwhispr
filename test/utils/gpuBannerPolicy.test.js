const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/gpuBannerPolicy.ts");

test("cloud cleanup (openwhispr default) is not eligible for the intelligence GPU offer", async () => {
  const { eligibleGpuOffers } = await load();

  const offers = eligibleGpuOffers({
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    useCleanupModel: true,
    cleanupMode: "openwhispr",
  });

  assert.equal(offers.intelligence, false);
});

test("cloud cleanup modes are never eligible even with cleanup enabled", async () => {
  const { eligibleGpuOffers } = await load();

  for (const cleanupMode of ["openwhispr", "providers", "self-hosted", "enterprise"]) {
    const offers = eligibleGpuOffers({
      useLocalWhisper: false,
      localTranscriptionProvider: "whisper",
      useCleanupModel: true,
      cleanupMode,
    });
    assert.equal(offers.intelligence, false, `cleanupMode=${cleanupMode}`);
  }
});

test("local cleanup with the model enabled is eligible for the intelligence GPU offer", async () => {
  const { eligibleGpuOffers } = await load();

  const offers = eligibleGpuOffers({
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    useCleanupModel: true,
    cleanupMode: "local",
  });

  assert.equal(offers.intelligence, true);
});

test("local cleanup with the model disabled is not eligible", async () => {
  const { eligibleGpuOffers } = await load();

  const offers = eligibleGpuOffers({
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    useCleanupModel: false,
    cleanupMode: "local",
  });

  assert.equal(offers.intelligence, false);
});

test("local whisper transcription is eligible for the transcription GPU offer", async () => {
  const { eligibleGpuOffers } = await load();

  const offers = eligibleGpuOffers({
    useLocalWhisper: true,
    localTranscriptionProvider: "whisper",
    useCleanupModel: false,
    cleanupMode: "openwhispr",
  });

  assert.equal(offers.transcription, true);
});

test("cloud transcription and non-whisper local providers are not eligible", async () => {
  const { eligibleGpuOffers } = await load();

  const cloud = eligibleGpuOffers({
    useLocalWhisper: false,
    localTranscriptionProvider: "whisper",
    useCleanupModel: false,
    cleanupMode: "openwhispr",
  });
  assert.equal(cloud.transcription, false);

  const parakeet = eligibleGpuOffers({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    useCleanupModel: false,
    cleanupMode: "openwhispr",
  });
  assert.equal(parakeet.transcription, false);
});
