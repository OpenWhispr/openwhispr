const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/localColdStart.js");

describe("localColdStart (#1078)", () => {
  it("detects downloaded whisper/parakeet selection", async () => {
    const {
      isSelectedLocalModelDownloaded,
    } = await load();

    assert.equal(
      isSelectedLocalModelDownloaded({
        localTranscriptionProvider: "whisper",
        whisperModel: "base",
        whisperModels: [{ model: "base", downloaded: true }],
      }),
      true
    );
    assert.equal(
      isSelectedLocalModelDownloaded({
        localTranscriptionProvider: "nvidia",
        parakeetModel: "pk-1",
        parakeetModels: [{ model: "pk-1", downloaded: true }],
      }),
      true
    );
    assert.equal(
      isSelectedLocalModelDownloaded({
        localTranscriptionProvider: "whisper",
        whisperModel: "base",
        whisperModels: [{ model: "base", downloaded: false }],
      }),
      false
    );
  });

  it("reads provider-specific server ready flags", async () => {
    const { isLocalServerReady } = await load();
    assert.equal(isLocalServerReady("whisper", { running: true }, { running: false }), true);
    assert.equal(isLocalServerReady("nvidia", { running: true }, { running: false }), false);
    assert.equal(isLocalServerReady("nvidia", { running: false }, { running: true }), true);
  });

  it("detects whisper CUDA/Vulkan acceleration", async () => {
    const { hasWhisperGpuAcceleration } = await load();
    assert.equal(
      hasWhisperGpuAcceleration({
        cudaEnabled: true,
        cudaDownloaded: true,
        vulkanEnabled: false,
        vulkanDownloaded: false,
      }),
      true
    );
    assert.equal(
      hasWhisperGpuAcceleration({
        cudaEnabled: false,
        cudaDownloaded: false,
        vulkanEnabled: true,
        vulkanDownloaded: true,
      }),
      true
    );
    assert.equal(
      hasWhisperGpuAcceleration({
        cudaEnabled: true,
        cudaDownloaded: false,
        vulkanEnabled: false,
        vulkanDownloaded: false,
      }),
      false
    );
  });

  it("returns null when not in local mode or model missing", async () => {
    const { resolveLocalColdStartHint } = await load();
    assert.equal(
      resolveLocalColdStartHint({
        useLocalWhisper: false,
        selectedModelDownloaded: true,
        localServerReady: false,
        hasNvidiaGpu: false,
        whisperGpuAcceleration: false,
      }),
      null
    );
    assert.equal(
      resolveLocalColdStartHint({
        useLocalWhisper: true,
        selectedModelDownloaded: false,
        localServerReady: false,
        hasNvidiaGpu: false,
        whisperGpuAcceleration: false,
      }),
      null
    );
  });

  it("prefers cold-start when local server is not ready", async () => {
    const { resolveLocalColdStartHint } = await load();
    assert.equal(
      resolveLocalColdStartHint({
        useLocalWhisper: true,
        localTranscriptionProvider: "whisper",
        selectedModelDownloaded: true,
        localServerReady: false,
        hasNvidiaGpu: false,
        whisperGpuAcceleration: false,
      }),
      "cold-start"
    );
  });

  it("returns no-gpu when local server is ready without acceleration", async () => {
    const { resolveLocalColdStartHint } = await load();
    assert.equal(
      resolveLocalColdStartHint({
        useLocalWhisper: true,
        localTranscriptionProvider: "whisper",
        selectedModelDownloaded: true,
        localServerReady: true,
        hasNvidiaGpu: false,
        whisperGpuAcceleration: false,
      }),
      "no-gpu"
    );
    assert.equal(
      resolveLocalColdStartHint({
        useLocalWhisper: true,
        localTranscriptionProvider: "nvidia",
        selectedModelDownloaded: true,
        localServerReady: true,
        hasNvidiaGpu: false,
        whisperGpuAcceleration: false,
      }),
      "no-gpu"
    );
    assert.equal(
      resolveLocalColdStartHint({
        useLocalWhisper: true,
        localTranscriptionProvider: "whisper",
        selectedModelDownloaded: true,
        localServerReady: true,
        hasNvidiaGpu: false,
        whisperGpuAcceleration: true,
      }),
      null
    );
  });

  it("maps tray and badge i18n keys", async () => {
    const {
      resolveLocalColdStartTrayKey,
      resolveLocalColdStartBadgeKeys,
    } = await load();

    assert.equal(resolveLocalColdStartTrayKey("cold-start"), "tray.tooltipLocalColdStart");
    assert.equal(resolveLocalColdStartTrayKey("no-gpu"), "tray.tooltipLocalNoGpu");
    assert.equal(resolveLocalColdStartTrayKey(null), "tray.tooltip");

    assert.deepEqual(resolveLocalColdStartBadgeKeys("cold-start"), {
      badge: "settingsPage.transcription.coldStartBadge",
      hint: "settingsPage.transcription.coldStartHint",
    });
    assert.deepEqual(resolveLocalColdStartBadgeKeys("no-gpu"), {
      badge: "settingsPage.transcription.noGpuBadge",
      hint: "settingsPage.transcription.noGpuHint",
    });
    assert.equal(resolveLocalColdStartBadgeKeys(null), null);
  });
});
