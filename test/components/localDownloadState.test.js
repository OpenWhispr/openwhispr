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

test("hydration cannot resurrect a download removed by a live terminal event", async () => {
  const { mergeHydratedDownloads } = await load();
  const staleInventory = {
    "whisper:base": { percentage: 92 },
    "llm:qwen": { percentage: 40 },
  };

  assert.deepEqual(mergeHydratedDownloads(staleInventory, {}, new Set(["whisper:base"])), {
    "llm:qwen": { percentage: 40 },
  });
});

test("live download state takes precedence over the hydration snapshot", async () => {
  const { mergeHydratedDownloads } = await load();

  assert.deepEqual(
    mergeHydratedDownloads(
      { "llm:qwen": { percentage: 40 } },
      { "llm:qwen": { percentage: 55 } },
      new Set()
    ),
    { "llm:qwen": { percentage: 55 } }
  );
});

test("the tray header only claims installation once every row is installing", async () => {
  const { isTrayInstalling } = await load();

  assert.equal(isTrayInstalling([{ installing: true }]), true);
  assert.equal(isTrayInstalling([{ installing: true }, { installing: true }]), true);
  assert.equal(isTrayInstalling([{ installing: true }, { installing: false }]), false);
  assert.equal(isTrayInstalling([]), false);
});

test("a failed row is not a transfer the header has to wait for", async () => {
  const { isTrayInstalling } = await load();

  // An error row has already stopped, so holding the header on "downloading"
  // for it would describe a transfer that is no longer running.
  assert.equal(isTrayInstalling([{ installing: true }, { error: "boom" }]), true);
  assert.equal(isTrayInstalling([{ error: "boom" }]), false);
  assert.equal(isTrayInstalling([{ installing: false }, { error: "boom" }]), false);
});

test("the installing ellipsis cycles nothing, one, two, three dots and restarts", async () => {
  const { ellipsisFrame } = await load();

  assert.deepEqual([0, 1, 2, 3, 4, 5].map(ellipsisFrame), ["", ".", "..", "...", "", "."]);
});
