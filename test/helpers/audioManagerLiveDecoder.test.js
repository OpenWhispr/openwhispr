const test = require("node:test");
const assert = require("node:assert/strict");
const { loadAudioManager } = require("./harness/audioManager");

// How a recording's LiveParakeetDecoder feeds processWithLocalParakeet, and
// which local providers get one.

async function loadManager(t, settings = {}) {
  const { window, setSettings, createManager } = await loadAudioManager(t, {
    cachePrefix: "openwhispr-live-decoder-test-",
    settingsKey: "__liveDecoderSettings",
  });
  setSettings({
    useLocalWhisper: true,
    localTranscriptionProvider: "nvidia",
    parakeetModel: "parakeet-unified-en-0.6b",
    preferredLanguage: "en",
    customDictionary: [],
    ...settings,
  });
  const batch = [];
  window.electronAPI.transcribeLocalParakeet = async (buffer, options) => {
    batch.push(options);
    return { success: true, text: "batch text" };
  };
  const manager = createManager({ processTranscription: async (text) => text });
  return { manager, batch };
}

const webm = () => new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
const wav = () => new Blob([new Uint8Array([82, 73, 70, 70])], { type: "audio/wav" });

function fakeDecoder(text) {
  const calls = [];
  return {
    calls,
    segmentCount: 2,
    finish: async (rawWav, route) => {
      calls.push({ rawWav, route });
      return text;
    },
  };
}

test("a live transcript replaces the batch decode", async (t) => {
  const { manager, batch } = await loadManager(t);
  const liveDecoder = fakeDecoder("live text");
  const rawWav = wav();

  const result = await manager.processWithLocalParakeet(webm(), "parakeet-unified-en-0.6b", {
    rawWav,
    liveDecoder,
  });

  assert.equal(result.text, "live text");
  assert.equal(batch.length, 0);
  assert.equal(liveDecoder.calls[0].rawWav, rawWav);
  assert.deepEqual(liveDecoder.calls[0].route, {
    model: "parakeet-unified-en-0.6b",
    language: "en",
  });
});

test("a streamed preview transcript wins over the live one", async (t) => {
  const { manager, batch } = await loadManager(t);
  const liveDecoder = fakeDecoder("live text");

  const result = await manager.processWithLocalParakeet(webm(), "parakeet-unified-en-0.6b", {
    rawWav: wav(),
    streamedText: "streamed text",
    liveDecoder,
  });

  assert.equal(result.text, "streamed text");
  assert.equal(liveDecoder.calls.length, 0);
  assert.equal(batch.length, 0);
});

test("no live transcript falls through to the batch decode", async (t) => {
  const { manager, batch } = await loadManager(t);

  const result = await manager.processWithLocalParakeet(webm(), "parakeet-unified-en-0.6b", {
    rawWav: wav(),
    liveDecoder: fakeDecoder(null),
  });

  assert.equal(result.text, "batch text");
  assert.equal(batch.length, 1);
});

test("only the offline Parakeet provider gets a live decoder", async (t) => {
  for (const [provider, expected] of [
    ["nvidia", true],
    ["cohere", false],
    ["whisper", false],
  ]) {
    const { manager } = await loadManager(t, { localTranscriptionProvider: provider });
    manager._batchPcmTap = { onSamples: null };
    manager._startLiveDecoder();
    assert.equal(Boolean(manager._liveDecoder), expected, provider);
    manager._liveDecoder?.stop();
  }
});

test("no tap, no live decoder", async (t) => {
  const { manager } = await loadManager(t);
  manager._batchPcmTap = null;
  manager._startLiveDecoder();
  assert.ok(!manager._liveDecoder);
});
