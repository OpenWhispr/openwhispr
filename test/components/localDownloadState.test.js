const assert = require("node:assert/strict");
const test = require("node:test");

const load = () => import("../../src/components/onboarding/localDownloadState.ts");

test("transcription transfers only unlock the dictation stage", async () => {
  const { isLocalStageDownloadActive } = await load();
  const whisper = { whisper: true, parakeet: false, llm: false };
  const parakeet = { whisper: false, parakeet: true, llm: false };

  assert.equal(isLocalStageDownloadActive("dictation", whisper), true);
  assert.equal(isLocalStageDownloadActive("dictation", parakeet), true);
  assert.equal(isLocalStageDownloadActive("assistant", whisper), false);
  assert.equal(isLocalStageDownloadActive("assistant", parakeet), false);
});

test("an LLM transfer only unlocks the assistant stage", async () => {
  const { isLocalStageDownloadActive } = await load();
  const llm = { whisper: false, parakeet: false, llm: true };

  assert.equal(isLocalStageDownloadActive("dictation", llm), false);
  assert.equal(isLocalStageDownloadActive("assistant", llm), true);
});
