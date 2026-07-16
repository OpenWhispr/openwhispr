const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/retryTranscriptionRouting.js");

test("selects self-hosted retry routing over stale cloud settings", async () => {
  const { resolveSelfHostedRetryRoute } = await load();

  for (const provider of ["groq", "openai", "mistral", "xai", "tinfoil", "custom"]) {
    const route = resolveSelfHostedRetryRoute({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl: "http://localhost:5001/v1",
      remoteTranscriptionModel: "  self-hosted-model  ",
      useLocalWhisper: true,
      cloudTranscriptionMode: "openwhispr",
      cloudTranscriptionProvider: provider,
      cloudTranscriptionModel: "stale-cloud-model",
    });

    assert.deepEqual(route, {
      kind: "self-hosted",
      endpoint: "http://localhost:5001/v1/audio/transcriptions",
      model: "self-hosted-model",
    });
  }
});

test("normalizes supported self-hosted URLs and allows private HTTP endpoints", async () => {
  const { resolveSelfHostedRetryRoute } = await load();
  const cases = [
    ["http://localhost:5001", "http://localhost:5001/audio/transcriptions"],
    ["http://localhost:5001/v1", "http://localhost:5001/v1/audio/transcriptions"],
    ["http://127.0.0.1:5001/v1", "http://127.0.0.1:5001/v1/audio/transcriptions"],
    ["http://192.168.1.20:5001/v1", "http://192.168.1.20:5001/v1/audio/transcriptions"],
    [
      "http://localhost:5001/v1/audio/transcriptions",
      "http://localhost:5001/v1/audio/transcriptions",
    ],
    [
      "  http://localhost:5001/v1/audio/transcriptions///  ",
      "http://localhost:5001/v1/audio/transcriptions",
    ],
  ];

  for (const [remoteTranscriptionUrl, endpoint] of cases) {
    const route = resolveSelfHostedRetryRoute({
      transcriptionMode: "self-hosted",
      remoteTranscriptionUrl,
    });
    assert.equal(route.kind, "self-hosted");
    assert.equal(route.endpoint, endpoint);
  }
});

test("fails closed for missing, malformed, or unsupported self-hosted URLs", async () => {
  const { resolveSelfHostedRetryRoute } = await load();
  const missingError = "Self-hosted transcription URL is not configured";
  const invalidError = "Self-hosted transcription URL is invalid or unsupported";
  const cases = [
    [undefined, missingError],
    [null, missingError],
    ["", missingError],
    ["   ", missingError],
    [42, missingError],
    ["not a url", invalidError],
    ["https://", invalidError],
    ["ftp://localhost:5001/v1", invalidError],
    ["http://example.com/v1", invalidError],
  ];

  for (const [remoteTranscriptionUrl, error] of cases) {
    assert.deepEqual(
      resolveSelfHostedRetryRoute({
        transcriptionMode: "self-hosted",
        remoteTranscriptionUrl,
        useLocalWhisper: true,
        cloudTranscriptionMode: "openwhispr",
        cloudTranscriptionProvider: "groq",
      }),
      {
        kind: "configuration-error",
        error,
      }
    );
  }
});

test("does not intercept non-self-hosted retry modes", async () => {
  const { resolveSelfHostedRetryRoute } = await load();

  for (const settings of [
    { transcriptionMode: "local", useLocalWhisper: true },
    { transcriptionMode: "openwhispr", cloudTranscriptionMode: "openwhispr" },
    { transcriptionMode: "providers", cloudTranscriptionProvider: "tinfoil" },
    { transcriptionMode: "providers", cloudTranscriptionProvider: "groq" },
    {},
  ]) {
    assert.equal(resolveSelfHostedRetryRoute(settings), null);
  }
});
