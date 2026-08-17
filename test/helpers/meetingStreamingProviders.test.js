const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/meetingStreamingProviders.js");

test("tinfoil-realtime resolves to the Tinfoil client, never the OpenAI default", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER } = await load();
  const { TinfoilRealtimeStreaming } =
    await import("../../src/helpers/tinfoilRealtimeStreaming.js");
  const OpenAIRealtimeStreaming = (await import("../../src/helpers/openaiRealtimeStreaming.js"))
    .default;

  assert.equal(STREAMING_CLIENT_BY_PROVIDER["tinfoil-realtime"], TinfoilRealtimeStreaming);
  assert.notEqual(STREAMING_CLIENT_BY_PROVIDER["tinfoil-realtime"], OpenAIRealtimeStreaming);
});

test("every allowed realtime provider has a streaming client (no silent OpenAI fallback)", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER, ALLOWED_MEETING_PROVIDERS } = await load();

  for (const provider of ALLOWED_MEETING_PROVIDERS) {
    if (provider === "local") continue;
    assert.equal(
      typeof STREAMING_CLIENT_BY_PROVIDER[provider],
      "function",
      `${provider} is allowed but would fall through to the OpenAI default class`
    );
  }
});

test("allow-list accepts tinfoil-realtime and local", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();

  assert.equal(ALLOWED_MEETING_PROVIDERS.has("tinfoil-realtime"), true);
  assert.equal(ALLOWED_MEETING_PROVIDERS.has("local"), true);
});

test("allow-list rejects unknown and batch-only providers", async () => {
  const { ALLOWED_MEETING_PROVIDERS } = await load();

  for (const provider of ["tinfoil", "openai", "mistral-realtime", "grok-stt", "", undefined]) {
    assert.equal(ALLOWED_MEETING_PROVIDERS.has(provider), false, `${provider} must be rejected`);
  }
});

test("client lookup fails closed instead of defaulting to OpenAI", async () => {
  const { getMeetingStreamingClient } = await load();

  assert.throws(() => getMeetingStreamingClient("unknown-realtime"), /Unsupported meeting/);
});

test("OpenAI-derived streaming clients carry their own provider log label", async () => {
  const { STREAMING_CLIENT_BY_PROVIDER } = await load();
  const OpenAIRealtimeStreaming = (await import("../../src/helpers/openaiRealtimeStreaming.js"))
    .default;
  const baseLabel = new OpenAIRealtimeStreaming().providerLabel;

  assert.equal(typeof baseLabel, "string");
  assert.ok(baseLabel.length > 0, "the base class must define a provider log label");

  for (const [provider, StreamingClient] of Object.entries(STREAMING_CLIENT_BY_PROVIDER)) {
    if (StreamingClient === OpenAIRealtimeStreaming) continue;
    if (!(StreamingClient.prototype instanceof OpenAIRealtimeStreaming)) continue;
    assert.notEqual(
      new StreamingClient().providerLabel,
      baseLabel,
      `${provider} inherits the OpenAI log label and would misreport where audio goes`
    );
  }
});

test("connection identity includes every provider-specific option", async () => {
  const { getMeetingConnectionKey } = await load();
  const options = {
    provider: "corti-realtime",
    model: "corti-transcribe",
    language: "en",
    mode: "byok",
    environment: "us",
    tenant: "tenant-a",
    keyterms: ["OpenWhispr"],
  };

  assert.equal(getMeetingConnectionKey(options), getMeetingConnectionKey({ ...options }));
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, provider: "tinfoil-realtime" })
  );
  assert.notEqual(
    getMeetingConnectionKey(options),
    getMeetingConnectionKey({ ...options, tenant: "tenant-b" })
  );
});
