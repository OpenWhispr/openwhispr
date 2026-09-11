const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

for (const streamingCommit of [false, true]) {
  test(`${streamingCommit ? "uncommitted online" : "offline"} preview stop preserves the complete final recording`, async (t) => {
    const { window, createManager } = await loadAudioManager(t, {
      cachePrefix: "openwhispr-preview-finalization-test-",
      settingsKey: "__previewFinalizationSettings",
      settings: {
        useLocalWhisper: true,
        localTranscriptionProvider: "nvidia",
        preferredLanguage: "en",
        allowOpenAIFallback: false,
      },
    });
    const bytes = Uint8Array.from({ length: 4096 }, (_, index) => index % 251);
    const recording = new Blob([bytes], { type: "audio/webm" });
    const calls = [];
    window.electronAPI.stopDictationPreview = async () => {
      calls.push("stop-preview");
      return { success: true, streamed: false, text: "incomplete preview" };
    };
    window.electronAPI.transcribeLocalParakeet = async (buffer, options) => {
      calls.push("final-decode");
      assert.deepEqual(new Uint8Array(buffer), bytes);
      assert.equal(options.model, "orukeet-v0.1.0-q8");
      return { success: true, text: "complete recording" };
    };
    let finalResult;
    const manager = createManager({
      micRecovery: { stop() {} },
      teardownSpeechGate() {},
      _batchSegments: [],
      _receivedAudioData: true,
      _streamingCommitActive: streamingCommit,
      recordingStartTime: Date.now() - 2000,
      _startProcessingPipeline: () => ({}),
      _shouldAbandonProcessingPipeline: () => false,
      shouldShowPreviewCleanupState: () => false,
      getEffectiveSttLanguage: () => "en",
      processTranscription: async (text) => text,
      async processAudio(blob, metadata) {
        assert.strictEqual(blob, recording);
        assert.equal(metadata.streamedText, undefined);
        finalResult = await this.processWithLocalParakeet(blob, "orukeet-v0.1.0-q8", metadata);
      },
    });

    await manager.finalizeBatchRecording(recording);

    assert.deepEqual(calls, ["stop-preview", "final-decode"]);
    assert.equal(finalResult.text, "complete recording");
    assert.equal(finalResult.rawText, "complete recording");
    assert.strictEqual(manager.lastAudioBlob, recording);
  });
}
