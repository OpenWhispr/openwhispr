const test = require("node:test");
const assert = require("node:assert/strict");
const {
  fourierPreferenceKey,
  selectedFourierBatch,
  savedAudioFourierAccount,
  FOURIER_MODEL,
} = require("../../src/helpers/fourierPilotSelection.js");

test("cloud Fourier selection is opt-in, scoped to the account and explicit English", (t) => {
  const config = {
    success: true,
    managed: false,
    optionalBatchModelAccount: "a",
    optionalBatchModels: [{ id: FOURIER_MODEL, languages: ["en"] }],
  };
  const values = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k) => values.get(k) },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else delete globalThis.localStorage;
  });
  const settings = { cloudTranscriptionMode: "openwhispr" };
  const use = (c = config, s = settings, l = "en-US") => selectedFourierBatch(c, s, l);
  assert.equal(use(), false);
  values.set(fourierPreferenceKey(config), "1");
  assert.equal(use(), true);
  for (const obj of [
    { managed: true },
    { optionalBatchModelAccount: "b" },
    { optionalBatchModels: [] },
    { success: false },
  ])
    assert.equal(use({ ...config, ...obj }), false);
  assert.equal(use(config, settings, "auto"), false);
  assert.equal(use(config, { cloudTranscriptionMode: "byok" }), false);
  assert.equal(use(config, { ...settings, useLocalWhisper: true }), false);
  assert.equal(savedAudioFourierAccount(settings, "a"), "a");
  assert.equal(savedAudioFourierAccount(settings, "b"), undefined);
  for (const hints of [
    { customDictionary: ["Amaya"] },
    { snippets: [{ trigger: "address", replacement: "123 Main St" }] },
    { sharedDictionaryHints: { space: [], workspace: ["Amaya"] } },
  ]) {
    assert.equal(savedAudioFourierAccount({ ...settings, ...hints }, "a"), undefined);
  }
});
