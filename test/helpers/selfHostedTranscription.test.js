const test = require("node:test");
const assert = require("node:assert/strict");

test("isSelfHostedTranscription returns true for self-hosted mode with configured URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    true
  );
});

test("isSelfHostedTranscription returns false for providers mode even with configured URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "providers",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
    }),
    false
  );
});

test("isSelfHostedTranscription returns false for empty URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
    }),
    false
  );
});

test("isSelfHostedTranscription returns false for whitespace-only URL", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(
    isSelfHostedTranscription({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "   ",
    }),
    false
  );
});

test("isSelfHostedTranscription returns false for empty settings object", async () => {
  const { isSelfHostedTranscription } = await import("../../src/helpers/selfHostedTranscription.js");
  assert.equal(isSelfHostedTranscription({}), false);
});

test("resolveSelfHostedTranscriptionModel returns the trimmed model", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "  custom-whisper  ",
    }),
    "custom-whisper"
  );
});

test("resolveSelfHostedTranscriptionModel returns null for empty model", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null for whitespace-only model", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "   ",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null when mode is not self-hosted", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "providers",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: "custom-whisper",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null when URL is empty", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "",
      remoteTranscriptionModel: "custom-whisper",
    }),
    null
  );
});

test("resolveSelfHostedTranscriptionModel returns null when remoteTranscriptionModel is not a string", async () => {
  const { resolveSelfHostedTranscriptionModel } = await import(
    "../../src/helpers/selfHostedTranscription.js"
  );
  assert.equal(
    resolveSelfHostedTranscriptionModel({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:8000/v1",
      remoteTranscriptionModel: 42,
    }),
    null
  );
});
