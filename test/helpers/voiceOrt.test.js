const test = require("node:test");
const assert = require("node:assert/strict");

const { loadVoiceOrt } = require("../../src/workers/voiceOrt");

test("an Intel Mac runs the speech models on the WASM build", () => {
  const { sessionOptions } = loadVoiceOrt({ platform: "darwin", arch: "x64" });
  assert.deepEqual(sessionOptions(2).executionProviders, ["wasm"]);
});

test("every other target runs them on the native runtime with the threads asked for", () => {
  const { sessionOptions } = loadVoiceOrt({ platform: "darwin", arch: "arm64" });
  const options = sessionOptions(2);
  assert.deepEqual(options.executionProviders, ["cpu"]);
  assert.equal(options.intraOpNumThreads, 2);
});
