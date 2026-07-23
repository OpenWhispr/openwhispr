const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/sttPosture.js");

test("hasDownloadedLocalModels is false when both lists are empty", async () => {
  const { hasDownloadedLocalModels } = await load();
  assert.equal(hasDownloadedLocalModels([], []), false);
  assert.equal(hasDownloadedLocalModels(undefined, undefined), false);
});

test("hasDownloadedLocalModels is true when Whisper or Parakeet has a download", async () => {
  const { hasDownloadedLocalModels } = await load();
  assert.equal(hasDownloadedLocalModels([{ model: "base", downloaded: true }], []), true);
  assert.equal(hasDownloadedLocalModels([], [{ id: "nemo", isDownloaded: true }]), true);
  assert.equal(hasDownloadedLocalModels([{ downloaded: false }], [{ downloaded: false }]), false);
});

test("isCloudTranscriptionActive: OpenWhispr Cloud requires sign-in", async () => {
  const { isCloudTranscriptionActive } = await load();
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      transcriptionMode: "openwhispr",
      isSignedIn: false,
    }),
    false
  );
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      transcriptionMode: "openwhispr",
      isSignedIn: true,
    }),
    true
  );
});

test("isCloudTranscriptionActive: BYOK requires a provider key", async () => {
  const { isCloudTranscriptionActive } = await load();
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "groq",
      groqApiKey: "",
    }),
    false
  );
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      transcriptionMode: "providers",
      cloudTranscriptionProvider: "groq",
      groqApiKey: "gsk_test",
    }),
    true
  );
});

test("isCloudTranscriptionActive: self-hosted needs a URL", async () => {
  const { isCloudTranscriptionActive } = await load();
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: false,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
    }),
    false
  );
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: false,
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8080/v1",
    }),
    true
  );
});

test("isCloudTranscriptionActive: local mode is never cloud-active", async () => {
  const { isCloudTranscriptionActive } = await load();
  assert.equal(
    isCloudTranscriptionActive({
      useLocalWhisper: true,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: true,
      openaiApiKey: "sk-test",
    }),
    false
  );
});

test("resolveSttPosture maps the three UX states (#1079)", async () => {
  const { resolveSttPosture } = await load();
  assert.equal(resolveSttPosture({ hasLocalModels: true, cloudActive: false }), "local-ready");
  assert.equal(resolveSttPosture({ hasLocalModels: true, cloudActive: true }), "local-ready");
  assert.equal(resolveSttPosture({ hasLocalModels: false, cloudActive: true }), "cloud-only");
  assert.equal(resolveSttPosture({ hasLocalModels: false, cloudActive: false }), "unconfigured");
});
