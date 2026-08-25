const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/transcriptionFallback.js");

test("signed-in OpenWhispr Cloud falls back to cloud", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: true,
    }),
    "cloud"
  );
});

test("signed-out OpenWhispr Cloud skips rather than diverting to a leftover BYOK provider", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "openwhispr",
      isSignedIn: false,
    }),
    "skip"
  );
});

test("BYOK mode falls back to the user's own provider", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "byok",
      isSignedIn: false,
    }),
    "byok"
  );
});

test("handles nullish parameters and case-insensitive cloudTranscriptionMode", async () => {
  const { resolveStreamingFallbackTarget } = await load();
  assert.equal(resolveStreamingFallbackTarget(), "byok");
  assert.equal(resolveStreamingFallbackTarget(null), "byok");
  assert.equal(resolveStreamingFallbackTarget(undefined), "byok");
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: "OpenWhispr",
      isSignedIn: true,
    }),
    "cloud"
  );
  assert.equal(
    resolveStreamingFallbackTarget({
      useLocalWhisper: false,
      cloudTranscriptionMode: " OPENWHISPR ",
      isSignedIn: false,
    }),
    "skip"
  );
});
