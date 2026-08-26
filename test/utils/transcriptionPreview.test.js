const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/utils/transcriptionPreview.ts");

test("live transcription preview remains available for local transcription", async () => {
  const { supportsLiveTranscriptionPreview } = await load();

  assert.equal(supportsLiveTranscriptionPreview("local"), true);
});

test("managed OpenWhispr Cloud does not advertise live transcription preview", async () => {
  const { supportsLiveTranscriptionPreview } = await load();

  assert.equal(supportsLiveTranscriptionPreview("openwhispr", true), false);
});

test("BYOK preview availability follows the selected model's streaming capability", async () => {
  const { supportsLiveTranscriptionPreview } = await load();

  assert.equal(supportsLiveTranscriptionPreview("providers", true), true);
  assert.equal(supportsLiveTranscriptionPreview("providers", false), false);
});

test("batch-only self-hosted transcription does not advertise live preview", async () => {
  const { supportsLiveTranscriptionPreview } = await load();

  assert.equal(supportsLiveTranscriptionPreview("self-hosted", true), false);
});

test("live preview joins completed cloud turns with the current partial turn", async () => {
  const { buildLiveTranscriptionPreview } = await load();

  assert.equal(
    buildLiveTranscriptionPreview("First sentence.", "Second sentence"),
    "First sentence. Second sentence"
  );
  assert.equal(buildLiveTranscriptionPreview("", "  Starting now  "), "Starting now");
});

test("streaming preview runs for BYOK only, even if a stale setting remains enabled", async () => {
  const { shouldShowByokStreamingPreview } = await load();

  assert.equal(shouldShowByokStreamingPreview(true, "byok"), true);
  assert.equal(shouldShowByokStreamingPreview(true, "openwhispr"), false);
  assert.equal(shouldShowByokStreamingPreview(false, "byok"), false);
});

test("assistant-routed recordings never show the dictation preview", async () => {
  const { shouldDisplayDictationPreview, shouldShowByokStreamingPreview } = await load();

  // Local preview window display flag.
  assert.equal(shouldDisplayDictationPreview(true, false), true);
  assert.equal(shouldDisplayDictationPreview(true, true), false);
  assert.equal(shouldDisplayDictationPreview(false, false), false);

  // The BYOK streaming preview follows the same rule.
  assert.equal(shouldShowByokStreamingPreview(true, "byok", true), false);
  assert.equal(shouldShowByokStreamingPreview(true, "byok", false), true);
});
